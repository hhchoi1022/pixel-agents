// Build ~/.pixel-agents from profile/common/ plus profile/machines/<target>.json.
// Files it would replace are copied to a timestamped backup folder first.
// Never touches the server token, server.json, standalone state or hooks/;
// hook consent is left unanswered so the first run asks.
//
//   node scripts/import-profile.mjs --target mcs [--dest ~/.pixel-agents]
//                                   [--profile ./profile] [--dry-run] [--force]
//
// --force: write even while a Pixel Agents server is running (it would write
// its in-memory layout back over the import, so stop it first instead).

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PROFILE_DIR,
  DEFAULT_STATE_DIR,
  joinPorts,
  liveServerPid,
  NAMESPACES,
  parseArgs,
  readJson,
  VERBATIM_FILES,
} from './profile-common.mjs';

const args = parseArgs(process.argv.slice(2));
if (typeof args.target !== 'string') {
  console.error(
    'usage: node scripts/import-profile.mjs --target <machine> [--dest DIR] [--dry-run] [--force]',
  );
  process.exit(2);
}
const profile = path.resolve(args.profile ?? DEFAULT_PROFILE_DIR);
const dest = path.resolve(args.dest ?? DEFAULT_STATE_DIR);
const dryRun = args['dry-run'] === true;
const common = path.join(profile, 'common');
const machine = readJson(path.join(profile, 'machines', `${args.target}.json`));

const pid = liveServerPid(dest);
if (pid && !args.force && !dryRun) {
  console.error(
    `A Pixel Agents server (pid ${pid}) is using ${dest}. Stop it first, or pass --force.`,
  );
  process.exit(1);
}

/** name → contents to write */
const out = new Map();

for (const name of VERBATIM_FILES) {
  const from = path.join(common, name);
  if (fs.existsSync(from)) out.set(name, fs.readFileSync(from, 'utf-8'));
}

// config.json: shared display options + this machine's Directories and Area
// mappings, merged over what's there so hook consent and the like survive.
const existing = readJson(path.join(dest, 'config.json'), {});
const shared = readJson(path.join(common, 'config.json'), {});
const config = { ...existing };
for (const ns of NAMESPACES) {
  config[ns] = {
    ...(existing[ns] ?? {}),
    ...(shared[ns] ?? {}),
    areaMappings: machine.areaMappings?.[ns] ?? {},
  };
}
config.directories = machine.directories ?? [];
config.externalAssetDirectories = machine.externalAssetDirectories ?? [];
if (machine.currentProject && config.directories.some((d) => d.path === machine.currentProject)) {
  config.currentProject = machine.currentProject;
} else {
  delete config.currentProject;
}
out.set('config.json', JSON.stringify(config, null, 2) + '\n');

const json = (v) => JSON.stringify(v, null, 2) + '\n';
out.set(
  'server-room.json',
  json({ ...readJson(path.join(common, 'server-room.json'), {}), ...(machine.serverRoom ?? {}) }),
);
out.set(
  'project-displays.json',
  json({
    ...readJson(path.join(common, 'project-displays.json'), {}),
    projects: machine.projectDisplays?.projects ?? {},
  }),
);
if (machine.pipelineSources) out.set('pipeline-status.json', json(machine.pipelineSources));
const portsHeader = path.join(common, 'ports.md');
if (fs.existsSync(portsHeader)) {
  out.set('ports.md', joinPorts(fs.readFileSync(portsHeader, 'utf-8'), machine.ports ?? []));
}

const replaced = [...out.keys()].filter((name) => fs.existsSync(path.join(dest, name)));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${dest}.backup-${stamp}`;

console.log(`${dryRun ? '[dry run] ' : ''}Import profile "${args.target}" → ${dest}`);
for (const name of out.keys())
  console.log(`  ${replaced.includes(name) ? 'replace' : 'create '} ${name}`);
if (dryRun) process.exit(0);

if (replaced.length > 0) {
  fs.mkdirSync(backup, { recursive: true });
  for (const name of replaced) fs.copyFileSync(path.join(dest, name), path.join(backup, name));
  console.log(`  backed up ${replaced.length} file(s) to ${backup}`);
}
fs.mkdirSync(dest, { recursive: true });
for (const [name, text] of out) {
  const target = path.join(dest, name);
  fs.writeFileSync(`${target}.tmp`, text);
  fs.renameSync(`${target}.tmp`, target);
}
console.log('Done. Start the server; the first run asks for Claude hook consent.');
