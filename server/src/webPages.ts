import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import {
  LAYOUT_FILE_DIR,
  WEB_PAGES_POLL_MS,
  WEB_PAGES_PROBE_TIMEOUT_MS,
  WEB_PAGES_REGISTRY_FILE_NAME,
  WEB_PAGES_SCAN_PORT_MAX,
  WEB_PAGES_SCAN_PORT_MIN,
} from './constants.js';
import { listProjects } from './directories.js';

/**
 * The hosted web pages, for the per-Area "웹" panels. Two sources: the port
 * registry (`~/.pixel-agents/ports.md`, a hand-edited markdown table of the
 * projects' permanent pages, owned by this repo) and a scan of the TCP
 * listeners in the 8760–8780 band. A registered port gets its live PID from
 * the scan; an unregistered listener shows as a one-off page with its PID,
 * cwd and command. Broadcast as `webPagesStatus`. Read-only — nothing here
 * signals a listener — and the same whichever project is open.
 */

export type WebPageState = 'permanent' | 'running' | 'stopped' | 'oneoff' | 'other';

export interface WebPageLink {
  /** Openable URL: the template cut back to the path above its placeholder. */
  href: string;
  /** The URL as written when it held a placeholder (`<objname>`), else null. */
  template: string | null;
}

export interface WebPageRow {
  port: number;
  /** "담당 agent" cell, split on `/` and `,`. */
  agents: string[];
  purpose: string;
  links: WebPageLink[];
  servingDir: string;
  state: WebPageState;
  statusText: string;
}

const strip = (cell: string | undefined): string => (cell ?? '').replace(/`/g, '').trim();

function classifyStatus(text: string): WebPageState {
  if (text.includes('일회성')) return 'oneoff';
  if (text.includes('종료')) return 'stopped';
  if (text.includes('상시')) return 'permanent';
  if (text.includes('실행')) return 'running';
  return 'other';
}

const URL_RE = /https?:\/\/[^\s`'")|]+/g;

/** One link per openable URL: a template whose parent path is already
 *  listed (`/ezphot/` beside `/ezphot/<objname>/viz/`) annotates that link
 *  instead of repeating it. */
function extractLinks(cell: string): WebPageLink[] {
  const byHref = new Map<string, WebPageLink>();
  for (const url of cell.match(URL_RE) ?? []) {
    const placeholder = url.indexOf('<');
    const href = placeholder < 0 ? url : url.slice(0, url.lastIndexOf('/', placeholder) + 1);
    if (!/^https?:\/\/[^/\s]+/.test(href)) continue;
    const template = placeholder < 0 ? null : url;
    const existing = byHref.get(href);
    if (!existing) byHref.set(href, { href, template });
    else if (!existing.template) existing.template = template;
  }
  return [...byHref.values()];
}

/**
 * Table rows only (`| <digits> |`); anything else — headers, prose, a row
 * someone broke — is skipped rather than guessed at. Columns: 포트 | 담당 |
 * 용도 | URL | 서빙 디렉토리 | 상태; trailing ones may be missing. No PID or
 * start time: those are scanned, never written down.
 */
export function parsePortsTable(markdown: string): WebPageRow[] {
  const rows: WebPageRow[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\s*\|\s*(\d{1,5})\s*\|/.exec(line);
    if (!m) continue;
    const port = Number(m[1]);
    if (port < 1 || port > 65535) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (cells.length < 4) continue;
    const statusText = strip(cells[5]);
    rows.push({
      port,
      agents: strip(cells[1])
        .split(/[/,]/)
        .map((a) => a.trim())
        .filter(Boolean),
      purpose: strip(cells[2]),
      links: extractLinks(cells[3] ?? ''),
      servingDir: strip(cells[4]),
      state: classifyStatus(statusText),
      statusText,
    });
  }
  return rows;
}

/** Whether something accepts TCP connections on 127.0.0.1:port. */
export function probePort(port: number, timeoutMs = WEB_PAGES_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** A process listening on a TCP port. pid/cwd/command are null when the
 *  socket's owner can't be seen (another user's process). */
export interface Listener {
  port: number;
  pid: number | null;
  cwd: string | null;
  command: string | null;
}

/** `port → socket inode` for the LISTEN sockets in [min, max], from the
 *  kernel's tcp tables (IPv4 and IPv6). */
export function parseProcNetTcp(table: string, min: number, max: number): Map<number, string[]> {
  const byPort = new Map<number, string[]>();
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
    if (f.length < 10 || f[3] !== '0A') continue;
    const port = parseInt(f[1].split(':')[1] ?? '', 16);
    if (!(port >= min && port <= max) || f[9] === '0') continue;
    const inodes = byPort.get(port) ?? [];
    if (!inodes.includes(f[9])) inodes.push(f[9]);
    byPort.set(port, inodes);
  }
  return byPort;
}

/** Every listener in [min, max] with the process holding it (Linux /proc;
 *  [] elsewhere). One row per port: a socket shared by a parent and its
 *  forked workers names the lowest PID. */
export function scanListeners(
  min = WEB_PAGES_SCAN_PORT_MIN,
  max = WEB_PAGES_SCAN_PORT_MAX,
  procRoot = '/proc',
): Listener[] {
  const byPort = new Map<number, string[]>();
  for (const table of ['tcp', 'tcp6']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(procRoot, 'net', table), 'utf-8');
    } catch {
      continue;
    }
    for (const [port, inodes] of parseProcNetTcp(text, min, max)) {
      byPort.set(port, [...(byPort.get(port) ?? []), ...inodes]);
    }
  }
  if (byPort.size === 0) return [];

  const wanted = new Map<string, number>();
  for (const [port, inodes] of byPort) for (const inode of inodes) wanted.set(inode, port);
  const holder = new Map<number, number>();
  let pids: string[] = [];
  try {
    pids = fs.readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    /* no /proc: ports without owners */
  }
  for (const pid of pids.map(Number).sort((a, b) => a - b)) {
    let fds: string[];
    try {
      fds = fs.readdirSync(path.join(procRoot, String(pid), 'fd'));
    } catch {
      continue; // gone, or not ours to look at
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = fs.readlinkSync(path.join(procRoot, String(pid), 'fd', fd));
      } catch {
        continue;
      }
      const port = wanted.get(/^socket:\[(\d+)\]$/.exec(target)?.[1] ?? '');
      if (port !== undefined && !holder.has(port)) holder.set(port, pid);
    }
    if (holder.size === byPort.size) break;
  }

  return [...byPort.keys()]
    .sort((a, b) => a - b)
    .map((port) => {
      const pid = holder.get(port) ?? null;
      if (pid === null) return { port, pid, cwd: null, command: null };
      const dir = path.join(procRoot, String(pid));
      let cwd: string | null = null;
      let command: string | null = null;
      try {
        cwd = fs.readlinkSync(path.join(dir, 'cwd'));
      } catch {
        /* unreadable */
      }
      try {
        command = fs.readFileSync(path.join(dir, 'cmdline'), 'utf-8').split('\0').join(' ').trim();
      } catch {
        /* unreadable */
      }
      return { port, pid, cwd, command: command || null };
    });
}

/** The project Directory a cwd sits in (symlinks resolved on both sides). */
export function projectForCwd(
  cwd: string,
  projects: ReadonlyArray<{ name: string; path: string }>,
): string | null {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const at = real(cwd);
  const hit = projects.find((p) => {
    const root = real(p.path);
    return at === root || at.startsWith(root + path.sep);
  });
  return hit?.name ?? null;
}

/** A registered page as broadcast: the row plus what the scan found. */
export interface WebPageStatus extends WebPageRow {
  /** Something is listening on the port. */
  live: boolean;
  /** The listening process, '' when none or not visible. */
  pid: string;
  cwd: string;
  command: string;
  /** The port's holder doesn't look like the registered server: its cwd and
   *  command line don't mention the serving directory, and its cwd isn't in
   *  the owning project's Directory either. */
  foreignHolder: boolean;
}

/** Merge the registry with the scan: each row takes its port's listener,
 *  and each listener no row claims becomes a one-off page. `probed` holds
 *  ports the scan couldn't attribute but that answered a loopback connect. */
export function mergeWebPages(
  rows: WebPageRow[],
  listeners: Listener[],
  probed: ReadonlySet<number>,
  projectOf: (cwd: string) => string | null,
): WebPageStatus[] {
  const byPort = new Map(listeners.map((l) => [l.port, l]));
  const registered = new Set(rows.map((r) => r.port));
  const pages: WebPageStatus[] = rows.map((row) => {
    const l = byPort.get(row.port);
    const cwd = l?.cwd ?? '';
    const command = l?.command ?? '';
    const dir = row.servingDir.replace(/\/+$/, '');
    const servesDir =
      dir !== '' && (cwd === dir || cwd.startsWith(dir + '/') || command.includes(dir));
    const owner = cwd ? projectOf(cwd)?.toLowerCase() : undefined;
    const inOwnerProject = owner !== undefined && row.agents.some((a) => a.toLowerCase() === owner);
    const foreignHolder =
      l !== undefined && l.pid !== null && dir !== '' && !servesDir && !inOwnerProject;
    return {
      ...row,
      live: l !== undefined || probed.has(row.port),
      pid: l !== undefined && l.pid !== null ? String(l.pid) : '',
      cwd,
      command,
      foreignHolder,
    };
  });
  for (const l of listeners) {
    if (registered.has(l.port)) continue;
    const project = l.cwd ? projectOf(l.cwd) : null;
    pages.push({
      port: l.port,
      agents: project ? [project] : [],
      purpose: '',
      links: [{ href: `http://127.0.0.1:${l.port}/`, template: null }],
      servingDir: l.cwd ?? '',
      state: 'oneoff',
      statusText: '일회성',
      live: true,
      pid: l.pid !== null ? String(l.pid) : '',
      cwd: l.cwd ?? '',
      command: l.command ?? '',
      foreignHolder: false,
    });
  }
  return pages.sort((a, b) => a.port - b.port);
}

export function webPagesRegistryPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, WEB_PAGES_REGISTRY_FILE_NAME);
}

/** Start polling and broadcasting. Returns a stop function. */
export function startWebPages(store: AgentStateStore): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow probe round must not stack up
    running = true;
    try {
      const source = webPagesRegistryPath();
      let rows: WebPageRow[] = [];
      let error: string | null = null;
      try {
        rows = parsePortsTable(fs.readFileSync(source, 'utf-8'));
      } catch {
        error = `${path.basename(source)} 없음`;
      }
      const listeners = scanListeners();
      // A registered port the scan missed (not Linux, or a socket outside
      // the band) still gets a loopback probe.
      const unseen = rows.map((r) => r.port).filter((p) => !listeners.some((l) => l.port === p));
      const answered = await Promise.all(
        [...new Set(unseen)].map(async (p) => [p, await probePort(p)] as const),
      );
      const projects = listProjects();
      store.broadcast({
        type: 'webPagesStatus',
        source,
        error,
        checkedAt: new Date().toISOString(),
        pages: mergeWebPages(
          rows,
          listeners,
          new Set(answered.filter(([, live]) => live).map(([p]) => p)),
          (cwd) => projectForCwd(cwd, projects),
        ),
      });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), WEB_PAGES_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
