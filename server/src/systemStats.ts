import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { readFile, statfs } from 'fs/promises';
import { homedir, hostname } from 'os';
import { join } from 'path';

import type { AgentStateStore } from './agentStateStore.js';

/**
 * System stats for the in-office server room: sampled from /proc and statfs,
 * broadcast as a `systemStats` message the webview renders as racks with
 * gauges. Standalone-only; configured by optional ~/.pixel-agents/server-room.json
 * ({ col, row, mounts?, name?, remotes? }) which positions the racks, picks the
 * mounts shown, names this host's rack group and lists the remote hosts.
 *
 * A remote host has no channel to us but a file: scripts/remote-system-stats.py
 * runs ON it and keeps replacing `statsFile` (shared storage, e.g. NFS) with
 * the same payload we sample here. A file that is missing, unreadable or older
 * than REMOTE_STALE_MS (or 3 of its own intervals) reads as offline (stats: null).
 */

const SAMPLE_INTERVAL_MS = 2_000;
const DISK_REFRESH_MS = 30_000;
/** No disk racks unless server-room.json names this machine's mounts. */
const DEFAULT_MOUNTS: string[] = [];
const DEFAULT_ANCHOR = { col: 2, row: 3 };
/** A remote's file older than this is offline: its script or host stopped.
 *  A slow feed gets REMOTE_STALE_INTERVALS of its own interval instead. */
const REMOTE_STALE_MS = 30_000;
const REMOTE_STALE_INTERVALS = 3;
const REMOTE_SCHEMA = 'pixel-agents-system-stats/1';

export interface SystemStatsPayload {
  cpuPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  ioReadBytesPerSec: number;
  ioWriteBytesPerSec: number;
  disks: { path: string; usedBytes: number; totalBytes: number }[];
  /** Top users by usage — cpu pct is top-style (100 = one full core). */
  users: {
    cpu: { name: string; pct: number }[];
    ram: { name: string; bytes: number }[];
  };
}

interface RemoteHost {
  name: string;
  statsFile: string;
}

interface ServerRoomConfig {
  col: number;
  row: number;
  mounts: string[];
  /** This host's rack-group title (default: the hostname, upper-cased). */
  name: string;
  remotes: RemoteHost[];
}

const defaultName = (): string => hostname().split('.')[0]!.toUpperCase();

function parseRemotes(raw: unknown): RemoteHost[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): RemoteHost[] => {
    if (typeof r !== 'object' || r === null) return [];
    const { name, statsFile } = r as Record<string, unknown>;
    return typeof name === 'string' && typeof statsFile === 'string' ? [{ name, statsFile }] : [];
  });
}

function loadServerRoomConfig(): ServerRoomConfig {
  const path = join(homedir(), '.pixel-agents', 'server-room.json');
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      return {
        col: typeof raw['col'] === 'number' ? raw['col'] : DEFAULT_ANCHOR.col,
        row: typeof raw['row'] === 'number' ? raw['row'] : DEFAULT_ANCHOR.row,
        mounts: Array.isArray(raw['mounts'])
          ? raw['mounts'].filter((m): m is string => typeof m === 'string')
          : DEFAULT_MOUNTS,
        name: typeof raw['name'] === 'string' ? raw['name'] : defaultName(),
        remotes: parseRemotes(raw['remotes']),
      };
    }
  } catch {
    /* unreadable config — fall through to defaults */
  }
  return { ...DEFAULT_ANCHOR, mounts: DEFAULT_MOUNTS, name: defaultName(), remotes: [] };
}

/**
 * One remote's stats file, or null when it can't be read, isn't ours or has
 * gone stale. Async on purpose: the file sits on a hard NFS mount, where a
 * synchronous read of an unresponsive server would freeze the whole process.
 */
async function readRemoteStats(path: string): Promise<SystemStatsPayload | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    if (raw['schema'] !== REMOTE_SCHEMA) return null;
    const generatedAt = raw['generatedAt'];
    const intervalSec = typeof raw['intervalSec'] === 'number' ? raw['intervalSec'] : 0;
    const staleMs = Math.max(REMOTE_STALE_MS, REMOTE_STALE_INTERVALS * intervalSec * 1000);
    if (typeof generatedAt !== 'number' || Date.now() - generatedAt > staleMs) return null;
    const stats = raw['stats'] as SystemStatsPayload | undefined;
    return stats && typeof stats.cpuPercent === 'number' ? stats : null;
  } catch {
    return null;
  }
}

function sampleCpu(): { busy: number; total: number } | null {
  try {
    const parts = readFileSync('/proc/stat', 'utf-8')
      .split('\n')[0]!
      .trim()
      .split(/\s+/)
      .slice(1)
      .map(Number);
    if (parts.length < 5 || parts.some(Number.isNaN)) return null;
    const total = parts.reduce((a, b) => a + b, 0);
    const idle = parts[3]! + (parts[4] ?? 0);
    return { busy: total - idle, total };
  } catch {
    return null;
  }
}

function sampleRam(): { used: number; total: number } | null {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const get = (key: string): number => {
      const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return m ? parseInt(m[1]!, 10) * 1024 : NaN;
    };
    const total = get('MemTotal');
    const available = get('MemAvailable');
    if (Number.isNaN(total) || Number.isNaN(available)) return null;
    return { used: total - available, total };
  } catch {
    return null;
  }
}

// Whole physical disks only — partitions and md/dm devices double-count bytes.
const WHOLE_DISK_RE = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+)$/;

function sampleIo(): { readSectors: number; writeSectors: number; time: number } | null {
  try {
    let readSectors = 0;
    let writeSectors = 0;
    for (const line of readFileSync('/proc/diskstats', 'utf-8').split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || !WHOLE_DISK_RE.test(f[2]!)) continue;
      readSectors += parseInt(f[5]!, 10);
      writeSectors += parseInt(f[9]!, 10);
    }
    return { readSectors, writeSectors, time: Date.now() };
  } catch {
    return null;
  }
}

async function sampleDisks(
  mounts: string[],
): Promise<{ path: string; usedBytes: number; totalBytes: number }[]> {
  const result: { path: string; usedBytes: number; totalBytes: number }[] = [];
  for (const path of mounts) {
    try {
      const s = await statfs(path);
      result.push({
        path,
        usedBytes: (s.blocks - s.bfree) * s.bsize,
        totalBytes: s.blocks * s.bsize,
      });
    } catch {
      /* mount unavailable — omit from this sample */
    }
  }
  return result;
}

// ── Per-user usage (for the expandable CPU / RAM rack panels) ──

const USER_SAMPLE_EVERY_TICKS = 3; // /proc full scan every ~6s
const TOP_USERS = 8;
const CLK_TCK = 100;

let passwdCache: Map<number, string> | null = null;
function uidName(uid: number): string {
  if (!passwdCache) {
    passwdCache = new Map();
    try {
      for (const line of readFileSync('/etc/passwd', 'utf-8').split('\n')) {
        const p = line.split(':');
        if (p.length >= 3) passwdCache.set(parseInt(p[2]!, 10), p[0]!);
      }
    } catch {
      /* fall back to numeric uids */
    }
  }
  return passwdCache.get(uid) ?? String(uid);
}

interface UserScan {
  ticksByUid: Map<number, number>;
  rssByUid: Map<number, number>;
  time: number;
}

function scanProcByUser(): UserScan {
  const ticksByUid = new Map<number, number>();
  const rssByUid = new Map<number, number>();
  let names: string[] = [];
  try {
    names = readdirSync('/proc');
  } catch {
    return { ticksByUid, rssByUid, time: Date.now() };
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const uid = statSync(`/proc/${name}`).uid;
      const stat = readFileSync(`/proc/${name}/stat`, 'utf-8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = parseInt(rest[11]!, 10) + parseInt(rest[12]!, 10); // utime + stime
      ticksByUid.set(uid, (ticksByUid.get(uid) ?? 0) + ticks);
      const rssPages = parseInt(readFileSync(`/proc/${name}/statm`, 'utf-8').split(' ')[1]!, 10);
      rssByUid.set(uid, (rssByUid.get(uid) ?? 0) + rssPages * 4096);
    } catch {
      /* process exited mid-scan — skip */
    }
  }
  return { ticksByUid, rssByUid, time: Date.now() };
}

function diffUsers(prev: UserScan, cur: UserScan): SystemStatsPayload['users'] {
  const elapsedSec = (cur.time - prev.time) / 1000;
  const cpu: { name: string; pct: number }[] = [];
  if (elapsedSec > 0) {
    for (const [uid, ticks] of cur.ticksByUid) {
      const delta = ticks - (prev.ticksByUid.get(uid) ?? 0);
      if (delta <= 0) continue;
      cpu.push({ name: uidName(uid), pct: (100 * delta) / (CLK_TCK * elapsedSec) });
    }
  }
  cpu.sort((a, b) => b.pct - a.pct);
  const ram = [...cur.rssByUid.entries()]
    .map(([uid, bytes]) => ({ name: uidName(uid), bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return { cpu: cpu.slice(0, TOP_USERS), ram: ram.slice(0, TOP_USERS) };
}

/** Start sampling and broadcasting. Returns a stop function. */
export function startSystemStats(store: AgentStateStore): () => void {
  const config = loadServerRoomConfig();
  let prevCpu = sampleCpu();
  let prevIo = sampleIo();
  let disks: SystemStatsPayload['disks'] = [];
  let disksSampledAt = 0;
  let prevUserScan = scanProcByUser();
  let users: SystemStatsPayload['users'] = { cpu: [], ram: [] };
  let tick = 0;
  // Latest read per remote; a read still pending (NFS stall) isn't restarted,
  // so a hung mount ties up one libuv thread per remote, never the pool.
  const remoteStats = new Map<string, SystemStatsPayload | null>();
  const remoteReading = new Set<string>();
  const refreshRemotes = (): void => {
    for (const r of config.remotes) {
      if (remoteReading.has(r.name)) continue;
      remoteReading.add(r.name);
      void readRemoteStats(r.statsFile).then((stats) => {
        remoteStats.set(r.name, stats);
        remoteReading.delete(r.name);
      });
    }
  };

  const timer = setInterval(() => {
    void (async () => {
      const cpu = sampleCpu();
      const ram = sampleRam();
      const io = sampleIo();

      let cpuPercent = 0;
      if (cpu && prevCpu && cpu.total > prevCpu.total) {
        cpuPercent = (100 * (cpu.busy - prevCpu.busy)) / (cpu.total - prevCpu.total);
      }
      prevCpu = cpu ?? prevCpu;

      let ioRead = 0;
      let ioWrite = 0;
      if (io && prevIo && io.time > prevIo.time) {
        const dt = (io.time - prevIo.time) / 1000;
        ioRead = Math.max(0, (io.readSectors - prevIo.readSectors) * 512) / dt;
        ioWrite = Math.max(0, (io.writeSectors - prevIo.writeSectors) * 512) / dt;
      }
      prevIo = io ?? prevIo;

      if (Date.now() - disksSampledAt > DISK_REFRESH_MS) {
        disks = await sampleDisks(config.mounts);
        disksSampledAt = Date.now();
      }

      refreshRemotes();

      tick++;
      if (tick % USER_SAMPLE_EVERY_TICKS === 0) {
        const scan = scanProcByUser();
        users = diffUsers(prevUserScan, scan);
        prevUserScan = scan;
      }

      const stats: SystemStatsPayload = {
        cpuPercent: Math.min(100, Math.max(0, cpuPercent)),
        ramUsedBytes: ram?.used ?? 0,
        ramTotalBytes: ram?.total ?? 0,
        ioReadBytesPerSec: ioRead,
        ioWriteBytesPerSec: ioWrite,
        disks,
        users,
      };
      store.broadcast({
        type: 'systemStats',
        name: config.name,
        stats,
        remotes: config.remotes.map((r) => ({
          name: r.name,
          stats: remoteStats.get(r.name) ?? null,
        })),
        anchor: { col: config.col, row: config.row },
      });
    })();
  }, SAMPLE_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
