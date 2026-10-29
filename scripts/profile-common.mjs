// Shared by export-profile.mjs and import-profile.mjs: where things live and
// how the machine-specific parts of ~/.pixel-agents are split out.
//
// profile/
//   common/                 the same on every machine
//     layout.json, agent-seats.json
//     config.json           display options per namespace (no areaMappings)
//     server-room.json      rack anchor { col, row }
//     project-displays.json band anchor { col, row, cols }
//     ports.md              the registry's prose + table header, no rows
//   machines/<name>.json    everything that names this machine's paths/hosts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROFILE_DIR = path.join(REPO_ROOT, 'profile');
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.pixel-agents');

/** Copied verbatim into common/. */
export const VERBATIM_FILES = ['layout.json', 'agent-seats.json'];
/** Per-namespace config keys that name this machine's Directories. */
export const MACHINE_NAMESPACE_KEYS = ['areaMappings'];
export const NAMESPACES = ['vscode', 'standalone'];

/** `--flag value` pairs and bare `--switch`es. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else {
      args[a.slice(2)] = next;
      i++;
    }
  }
  return args;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

const PORT_ROW = /^\s*\|\s*\d{1,5}\s*\|/;
const PORT_COLUMNS = ['port', 'owner', 'purpose', 'url', 'servingDir', 'status'];

/** ports.md → { header: everything but the port rows, rows: [{port, owner, …}] }. */
export function splitPorts(markdown) {
  const header = [];
  const rows = [];
  for (const line of markdown.split('\n')) {
    if (!PORT_ROW.test(line)) {
      header.push(line);
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    const row = {};
    PORT_COLUMNS.forEach((key, i) => {
      row[key] = (cells[i] ?? '').replace(/`/g, '').trim();
    });
    row.port = Number(row.port);
    rows.push(row);
  }
  while (header.length > 0 && header[header.length - 1].trim() === '') header.pop();
  return { header: header.join('\n') + '\n', rows };
}

/** The inverse: the header with the rows appended to its table. */
export function joinPorts(header, rows) {
  const code = (v) => (v ? `\`${v}\`` : '');
  const lines = rows.map(
    (r) =>
      `| ${r.port} | ${r.owner ?? ''} | ${r.purpose ?? ''} | ${code(r.url)} | ${code(r.servingDir)} | ${r.status ?? '상시'} |`,
  );
  return header.replace(/\n*$/, '\n') + lines.join('\n') + (lines.length ? '\n' : '');
}

/** Whether the server named in server.json is still running. */
export function liveServerPid(stateDir) {
  const info = readJson(path.join(stateDir, 'server.json'), null);
  const pid = info && Number(info.pid);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}
