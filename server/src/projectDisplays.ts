import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PROJECT_DISPLAYS_DEFAULT_ANCHOR, PROJECT_DISPLAYS_FILE } from './constants.js';

/**
 * Per-project office displays: the office shows the OPEN project's displays
 * in one band (anchor col/row, `cols` tiles wide), so each project brings its
 * own. Configured by optional ~/.pixel-agents/project-displays.json:
 *
 *   { "col": 1, "row": 16, "cols": 12,
 *     "projects": { "<Directory name>": { "alerts": {
 *        "statusFile": "...", "eventsFile": "...", "dashboardUrl": "..." } } } }
 *
 * `alerts` is an alert-feed antenna yard fed by a status file in BRIDGE's
 * `bridge-ops-status/1` schema (bridgeOps.ts) — any project whose monitor
 * writes that schema can have one. Without the file, no project has displays
 * (the paths are this machine's, so there is no default to fall back on).
 */

export interface ProjectAlerts {
  statusFile: string;
  /** events.jsonl with diagnosis report paths; null = no diagnoses. */
  eventsFile: string | null;
  /** Dashboard the panels link to (diagnosis paths are relative to it). */
  dashboardUrl: string | null;
}

export interface ProjectDisplays {
  alerts?: ProjectAlerts;
}

export interface ProjectDisplaysConfig {
  anchor: { col: number; row: number; cols: number };
  /** Keyed by Directory name, like areaMappings. */
  projects: Record<string, ProjectDisplays>;
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function parseAlerts(raw: unknown): ProjectAlerts | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.statusFile !== 'string') return undefined;
  return {
    statusFile: r.statusFile,
    eventsFile: strOrNull(r.eventsFile),
    dashboardUrl: strOrNull(r.dashboardUrl),
  };
}

export function loadProjectDisplays(
  file: string = path.join(os.homedir(), '.pixel-agents', PROJECT_DISPLAYS_FILE),
): ProjectDisplaysConfig {
  const d = PROJECT_DISPLAYS_DEFAULT_ANCHOR;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { anchor: { ...d }, projects: {} };
  }
  const projects: Record<string, ProjectDisplays> = {};
  if (typeof raw.projects === 'object' && raw.projects !== null) {
    for (const [name, p] of Object.entries(raw.projects as Record<string, unknown>)) {
      const alerts = parseAlerts((p as Record<string, unknown> | null)?.alerts);
      projects[name] = alerts ? { alerts } : {};
    }
  }
  return {
    anchor: {
      col: numOr(raw.col, d.col),
      row: numOr(raw.row, d.row),
      cols: numOr(raw.cols, d.cols),
    },
    projects,
  };
}
