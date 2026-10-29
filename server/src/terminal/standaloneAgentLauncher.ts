/**
 * Standalone agent launch: the PTY-backed counterpart to the VS Code adapter's
 * launchNewTerminal().
 *
 * This deliberately MIRRORS adapters/vscode/agentManager.ts rather than sharing
 * a core seam with it: that function imports `vscode` (so it can't move into
 * server/) and takes twelve positional dependencies, so unifying the two would
 * mean rewriting the whole VS Code lifecycle -- out of scope here and a certain
 * conflict with the sibling branches. What IS shared is the thing that matters:
 * both call provider.buildLaunchCommand(), so the launched command is identical.
 * Unifying the hosting is deferred (docs/design/standalone-terminal.md).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider, LaunchPeers } from '../../../core/src/provider.js';
import type { AgentRuntime } from '../agentRuntime.js';
import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import {
  JSONL_POLL_INTERVAL_MS,
  LAUNCH_LEAD_ROLE,
  LAUNCH_SESSION_NAME_ID_LENGTH,
  SUPERAGENT_DIRECTORY_NAME,
} from '../constants.js';
import {
  currentProjectFolder,
  directoryNameForLaunch,
  isSuperagentDirectory,
  listProjects,
  projectAt,
  projectsMessage,
  setCurrentProject,
} from '../directories.js';
import { startFileWatching } from '../fileWatcher.js';
import { directoryNameFor, hostDirectory } from '../hostDirectory.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import { isSessionId } from '../resumableSessions.js';
import type { AgentState } from '../types.js';
import type { PtySessionManager } from './ptySessionManager.js';

export interface LaunchStandaloneAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  ptyManager: PtySessionManager;
  provider: HookProvider;
}

export interface LaunchStandaloneAgentOptions {
  /** Path of the Directory to launch into. Defaults to the server's cwd, which
   *  is also the Directory standalone contributes as its host entry. */
  directoryPath?: string;
  /** Read from the host's persisted permission posture by the caller; never a
   *  per-launch choice made in the office. */
  bypassPermissions?: boolean;
  /** Continue this session (`--resume`) instead of starting a new one. Refused
   *  unless its transcript is in the Directory's session dir and no process --
   *  in the office or anywhere else -- holds it. */
  resumeSessionId?: string;
  cols?: number;
  rows?: number;
}

/**
 * Spawn a Claude agent in a PTY and register it with the runtime.
 * Returns the new agent id, or null when the terminal is unavailable.
 */
export function launchStandaloneAgent(
  deps: LaunchStandaloneAgentDeps,
  options: LaunchStandaloneAgentOptions = {},
): number | null {
  const { store, runtime, ptyManager, provider } = deps;

  if (!ptyManager.isAvailable()) {
    console.error(`[Pixel Agents] Terminal: cannot launch -- ${ptyManager.unavailableReason()}`);
    return null;
  }

  const cwd = options.directoryPath ?? process.cwd();
  const resume = options.resumeSessionId;
  if (resume !== undefined) {
    const refusal = resumeRefusal(deps, cwd, resume);
    if (refusal !== undefined) {
      console.error(`[Pixel Agents] Terminal: cannot resume ${resume} -- ${refusal}`);
      return null;
    }
  }
  // A resumed session keeps its id, so its name (`launchPeers` takes the id's
  // head) is the one the superagent already knows it by.
  const sessionId = resume ?? crypto.randomUUID();
  // The character's origin label (and its Area-mapping key): the name of the
  // Directory it was launched into, as the user named it — so an entry called
  // "Side Project" labels its agents that, not "side-project", and the Areas
  // it was assigned in the modal actually match. Falls back to the basename
  // for a cwd that is no Directory at all.
  const directoryName = directoryNameForLaunch(cwd, [hostDirectory()]) ?? directoryNameFor(cwd);
  // A project Directory is the project the agent belongs to; the superagent's
  // (and any other) Directory belongs to none, so it shows in every project.
  const projectPath = projectAt(cwd)?.path;

  const launch = provider.buildLaunchCommand?.(sessionId, cwd, {
    bypassPermissions: options.bypassPermissions,
    peers: launchPeers(cwd, sessionId),
    resume: resume !== undefined,
  });
  if (!launch) {
    console.error('[Pixel Agents] Terminal: provider.buildLaunchCommand is not implemented');
    return null;
  }

  const dirs = provider.getSessionDirs?.(cwd) ?? [];
  if (dirs.length === 0) {
    console.error('[Pixel Agents] Terminal: provider returned no session dirs');
    return null;
  }
  const projectDir = dirs[0];

  const id = store.nextAgentId.current++;

  let session;
  try {
    session = ptyManager.create({
      agentId: id,
      command: launch.command,
      args: launch.args,
      cwd,
      env: launch.env,
      cols: options.cols,
      rows: options.rows,
    });
  } catch (err) {
    // Roll the id back so a failed spawn doesn't burn an agent id.
    store.nextAgentId.current--;
    console.error(`[Pixel Agents] Terminal: spawn failed: ${String(err)}`);
    return null;
  }

  // Pre-register the expected JSONL so the project scanner doesn't mistake it
  // for a /clear file, exactly as the VS Code path does.
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  runtime.knownJsonlFiles.add(expectedFile);
  if (resume !== undefined) {
    // Closing the session's previous agent dismissed its transcript; this
    // agent is the one that owns it now.
    runtime.dismissalTracker.clearDismissal(expectedFile);
    runtime.dismissalTracker.clearSeededMtime(expectedFile);
  }

  const agent = createAgentState({
    id,
    sessionId,
    // Not external: this server owns the process. External agents are the ones
    // adopted from someone else's terminal, and they're what the stale-check and
    // restore paths act on -- a PTY agent must be excluded from both.
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
    directoryName,
    projectPath,
    providerId: provider.id,
  });
  if (resume !== undefined) {
    // Watch from the end: the turns already on disk are history, not activity.
    // The context gauge still comes from the tail (seedContextUsage).
    agent.fileOffset = fileSize(expectedFile);
  }

  // Server-side, like every other creation path: the palette rides the
  // agentCreated broadcast and is persisted with the agent, so a reload
  // restores the same character without the webview having to save it back.
  assignPaletteIfNeeded(agent, store);
  store.set(id, agent);
  runtime.activeAgentId.current = id;

  runtime.registerAgent(sessionId, id);
  store.persist();

  console.log(
    `[Pixel Agents] Terminal: Agent ${id} - spawned ${launch.command} (pid ${session.pid}) in ${cwd}`,
  );

  // Tell the UI a terminal exists for this agent, so the drawer opens a tab.
  // A separate message (rather than a field on agentCreated) keeps the protocol
  // change additive for the sibling branches.
  store.broadcast({ type: 'terminalSessionOpened', agentId: id });

  // The terminal closing is this surface's equivalent of VS Code's
  // "terminal closed -> clean up orphan" pass in fileWatcher.
  session.onExit((exit) => {
    console.log(`[Pixel Agents] Terminal: Agent ${id} - exited (code ${exit.exitCode})`);
    store.broadcast({ type: 'terminalSessionClosed', agentId: id, exitCode: exit.exitCode });
    if (store.has(id)) {
      runtime.unregisterAgent(agent.sessionId);
      runtime.closeAgent(id);
    }
  });

  startJsonlPoll(deps, id, agent);

  // Launching into another project opens it, so the new agent isn't born hidden.
  if (projectPath && projectPath !== currentProjectFolder() && setCurrentProject(projectPath)) {
    store.broadcast(projectsMessage());
  }

  return id;
}

/** Why `sessionId` can't be resumed in `cwd`, or undefined when it can. */
function resumeRefusal(
  deps: LaunchStandaloneAgentDeps,
  cwd: string,
  sessionId: string,
): string | undefined {
  if (!isSessionId(sessionId)) return 'not a session id';
  for (const agent of deps.store.values()) {
    if (agent.sessionId === sessionId) return 'already in the office';
  }
  if (deps.provider.getLiveSessionIds?.().has(sessionId)) return 'running in another terminal';
  const projectDir = deps.provider.getSessionDirs?.(cwd)[0];
  if (projectDir === undefined || !fs.existsSync(path.join(projectDir, `${sessionId}.jsonl`))) {
    return `no transcript for it under ${cwd}`;
  }
  return undefined;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * How a launch into `cwd` is named: a project's lead is `<project>/lead-<id>`
 * (the project's Directory name as the prefix the superagent finds it by), the
 * superagent is `superagent-<id>` and told those projects, and a launch into
 * any other Directory goes unnamed. The session id's head ends each name
 * because Claude doesn't de-duplicate names.
 */
export function launchPeers(cwd: string, sessionId: string): LaunchPeers | undefined {
  const id = sessionId.slice(0, LAUNCH_SESSION_NAME_ID_LENGTH);
  const project = projectAt(cwd);
  if (project) {
    const projectName = project.name.trim().replace(/[\s/]+/g, '-') || 'project';
    return { sessionName: `${projectName}/${LAUNCH_LEAD_ROLE}-${id}` };
  }
  if (isSuperagentDirectory(cwd)) {
    return {
      sessionName: `${SUPERAGENT_DIRECTORY_NAME}-${id}`,
      leadProjects: listProjects().map((p) => p.name),
    };
  }
  return undefined;
}

/**
 * Wait for the session's JSONL to appear, then start watching it.
 *
 * Hooks (the default) already route by sessionId, so this is what backfills tool
 * content and keeps hooks-off standalone working at all. A resumed launch keeps
 * its session's id, so its transcript is already here and the first poll finds it.
 */
function startJsonlPoll(deps: LaunchStandaloneAgentDeps, id: number, agent: AgentState): void {
  const { store, runtime } = deps;
  let pollCount = 0;

  const timer = setInterval(() => {
    pollCount++;
    try {
      if (!fs.existsSync(agent.jsonlFile)) {
        if (pollCount === 10) {
          console.warn(
            `[Pixel Agents] Terminal: Agent ${id} - JSONL not found after 10s. Expected: ${agent.jsonlFile}`,
          );
        }
        return;
      }
      clearInterval(timer);
      runtime.jsonlPollTimers.delete(id);
      // The agent may have been closed while we waited.
      if (!store.has(id)) return;
      console.log(
        `[Pixel Agents] Terminal: Agent ${id} - found JSONL ${path.basename(agent.jsonlFile)}`,
      );
      startFileWatching(
        id,
        agent.jsonlFile,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
      );
    } catch {
      // File may not exist yet, or vanished mid-check; keep polling.
    }
  }, JSONL_POLL_INTERVAL_MS);

  runtime.jsonlPollTimers.set(id, timer);
}
