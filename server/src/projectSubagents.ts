import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import { PROJECT_SUBAGENTS_DIR, PROJECT_SUBAGENTS_POLL_MS } from './constants.js';

/**
 * A project's own sub-agent definitions, `<project>/.claude/agents/*.md`: the
 * office keeps one resident character per definition at the open project's
 * desks, and a spawn whose `subagent_type` names one wakes that character
 * instead of a transient Subtask. Read-only; only top-level files count, so
 * an `_archive/` folder (or an `_old.md`) stays out.
 */

/** The `name:` of a definition's frontmatter, else the file's stem. */
export function subagentNameOf(markdown: string, fileName: string): string {
  const stem = path.basename(fileName, '.md');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return stem;
  const line = /^name:[ \t]*(.+?)[ \t]*$/m.exec(m[1]);
  const name = line?.[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  return name || stem;
}

/** The project's sub-agent names in file order; [] without the folder. */
export function readProjectSubagents(projectPath: string): string[] {
  const dir = path.join(projectPath, PROJECT_SUBAGENTS_DIR);
  let files: string[];
  try {
    files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !/^[_.]/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const file of files) {
    try {
      const name = subagentNameOf(fs.readFileSync(path.join(dir, file), 'utf-8'), file);
      if (!names.includes(name)) names.push(name);
    } catch {
      /* unreadable definition: skip it */
    }
  }
  return names;
}

/** Re-announce the projects (`announce()`, the projectsLoaded message)
 *  whenever the open project's definitions change, so an added or renamed
 *  agent file shows without a reload. Returns a stop function. */
export function startProjectSubagentWatch(
  store: AgentStateStore,
  currentProject: () => string | undefined,
  announce: () => Record<string, unknown>,
): () => void {
  const signature = (): string => {
    const current = currentProject();
    return current === undefined ? '' : `${current}\n${readProjectSubagents(current).join('\n')}`;
  };
  let last = signature();
  const timer = setInterval(() => {
    const next = signature();
    if (next === last) return;
    last = next;
    store.broadcast(announce());
  }, PROJECT_SUBAGENTS_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
