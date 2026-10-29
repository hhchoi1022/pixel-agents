import * as fs from 'fs';

import type { AgentStateStore } from './agentStateStore.js';
import {
  BRIDGE_OPS_EVENTS_TAIL_BYTES,
  BRIDGE_OPS_POLL_MS,
  BRIDGE_OPS_SCHEMA,
  BRIDGE_OPS_STALE_INTERVALS,
} from './constants.js';
import { loadProjectDisplays } from './projectDisplays.js';

/**
 * Alert-feed status for the in-office antenna yard: re-reads the status.json
 * a project's ops monitor (BRIDGE's, today) replaces every interval_sec, and
 * broadcasts it as `bridgeOpsStatus`, tagged with the project (read-only — we never write BRIDGE's files). Like
 * systemStats it re-broadcasts on every tick, so a freshly connected office
 * has the picture within one poll, and `stale` flips on time even when the
 * file stops changing (the monitor itself died).
 */

export interface BridgeOpsBroadcast {
  /** The parsed status.json, or null when it can't be read or isn't ours. */
  status: Record<string, unknown> | null;
  /** generated_at older than BRIDGE_OPS_STALE_INTERVALS × interval_sec. */
  stale: boolean;
  /** Why status is null (missing file, parse error, schema bump). */
  error: string | null;
}

export function readBridgeOps(nowMs: number = Date.now(), statusPath: string): BridgeOpsBroadcast {
  let raw: string;
  try {
    raw = fs.readFileSync(statusPath, 'utf-8');
  } catch {
    return { status: null, stale: true, error: 'status.json 없음' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Replaced atomically upstream, so this is a genuinely broken file.
    return { status: null, stale: true, error: 'status.json 파싱 실패' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: null, stale: true, error: 'status.json 형식 오류' };
  }
  const status = parsed as Record<string, unknown>;
  if (status.schema !== BRIDGE_OPS_SCHEMA) {
    return { status: null, stale: true, error: `알 수 없는 schema: ${String(status.schema)}` };
  }
  if (!Array.isArray(status.feeds)) {
    return { status: null, stale: true, error: 'feeds 없음' };
  }
  const generatedMs =
    typeof status.generated_at === 'string' ? Date.parse(status.generated_at) : NaN;
  const intervalSec = typeof status.interval_sec === 'number' ? status.interval_sec : NaN;
  const stale =
    !Number.isFinite(generatedMs) ||
    !Number.isFinite(intervalSec) ||
    nowMs - generatedMs > BRIDGE_OPS_STALE_INTERVALS * intervalSec * 1000;
  return { status, stale, error: null };
}

export interface BridgeDiagnosis {
  /** Report path relative to the status dir / dashboard URL. */
  path: string;
  /** When the transition that triggered it happened (UTC ISO). */
  t: string;
  /** The state the feed turned into (unknown | stalled | down). */
  state: string;
}

/** A report path we can safely append to the dashboard URL: relative, no
 *  parent hops, nothing but path characters. */
const SAFE_REPORT_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

/**
 * The newest diagnosis report per feed, from the tail of events.jsonl.
 * Missing file or junk lines yield fewer (or no) entries, never a throw.
 */
export function readLatestDiagnoses(eventsPath: string): Record<string, BridgeDiagnosis> {
  let text: string;
  try {
    const fd = fs.openSync(eventsPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, BRIDGE_OPS_EVENTS_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  const latest: Record<string, BridgeDiagnosis> = {};
  // Append-only, so later lines win. A first line cut by the tail window
  // simply fails to parse.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof e.feed === 'string' &&
        typeof e.diagnosis === 'string' &&
        SAFE_REPORT_PATH.test(e.diagnosis)
      ) {
        latest[e.feed] = {
          path: e.diagnosis,
          t: typeof e.t === 'string' ? e.t : '',
          state: typeof e.state === 'string' ? e.state : '',
        };
      }
    } catch {
      /* partial or malformed line */
    }
  }
  return latest;
}

/** Start polling and broadcasting, one `bridgeOpsStatus` per project with an
 *  alert feed (projectDisplays.ts); the office shows the open project's.
 *  Returns a stop function. */
export function startBridgeOps(store: AgentStateStore): () => void {
  const { anchor, projects } = loadProjectDisplays();
  const tick = () => {
    for (const [project, { alerts }] of Object.entries(projects)) {
      if (!alerts) continue;
      store.broadcast({
        type: 'bridgeOpsStatus',
        project,
        anchor,
        dashboardUrl: alerts.dashboardUrl,
        ...readBridgeOps(Date.now(), alerts.statusFile),
        diagnoses: alerts.eventsFile ? readLatestDiagnoses(alerts.eventsFile) : {},
      });
    }
  };
  tick();
  const timer = setInterval(tick, BRIDGE_OPS_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
