// Export this machine's ~/.pixel-agents into the portable profile/ folder:
// the shared parts to profile/common/, this machine's paths and hosts to
// profile/machines/<name>.json. Secrets and live-server state are never read.
//
//   node scripts/export-profile.mjs [--machine wfm] [--src ~/.pixel-agents] [--profile ./profile]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PROFILE_DIR,
  DEFAULT_STATE_DIR,
  MACHINE_NAMESPACE_KEYS,
  NAMESPACES,
  parseArgs,
  readJson,
  splitPorts,
  VERBATIM_FILES,
  writeJson,
} from './profile-common.mjs';

const args = parseArgs(process.argv.slice(2));
const src = path.resolve(args.src ?? DEFAULT_STATE_DIR);
const profile = path.resolve(args.profile ?? DEFAULT_PROFILE_DIR);
const machine = (args.machine ?? os.hostname().split('.')[0]).toLowerCase();
const common = path.join(profile, 'common');
const machineFile = path.join(profile, 'machines', `${machine}.json`);

fs.mkdirSync(common, { recursive: true });
const wrote = [];

for (const name of VERBATIM_FILES) {
  const from = path.join(src, name);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(common, name));
  wrote.push(`common/${name}`);
}

// config.json: display options are shared; Directories, Area mappings and
// asset folders name this machine's paths. Hook consent is left out on
// purpose — each machine asks on its first run.
const config = readJson(path.join(src, 'config.json'), {});
const sharedConfig = {};
const areaMappings = {};
for (const ns of NAMESPACES) {
  if (!config[ns]) continue;
  const settings = { ...config[ns] };
  for (const key of MACHINE_NAMESPACE_KEYS) {
    if (key === 'areaMappings' && settings[key]) areaMappings[ns] = settings[key];
    delete settings[key];
  }
  sharedConfig[ns] = settings;
}
writeJson(path.join(common, 'config.json'), sharedConfig);
wrote.push('common/config.json');

const serverRoom = readJson(path.join(src, 'server-room.json'), {});
const { col: rackCol, row: rackRow, ...serverRoomMachine } = serverRoom;
writeJson(path.join(common, 'server-room.json'), { col: rackCol, row: rackRow });
wrote.push('common/server-room.json');

const displays = readJson(path.join(src, 'project-displays.json'), {});
const { projects = {}, ...band } = displays;
writeJson(path.join(common, 'project-displays.json'), band);
wrote.push('common/project-displays.json');

let ports = { header: '', rows: [] };
const portsFile = path.join(src, 'ports.md');
if (fs.existsSync(portsFile)) {
  ports = splitPorts(fs.readFileSync(portsFile, 'utf-8'));
  fs.writeFileSync(path.join(common, 'ports.md'), ports.header);
  wrote.push('common/ports.md');
}

const pipelineSources = readJson(path.join(src, 'pipeline-status.json'), null);

writeJson(machineFile, {
  directories: config.directories ?? [],
  ...(config.currentProject ? { currentProject: config.currentProject } : {}),
  areaMappings,
  externalAssetDirectories: config.externalAssetDirectories ?? [],
  serverRoom: serverRoomMachine,
  projectDisplays: { projects },
  ...(pipelineSources ? { pipelineSources } : {}),
  ports: ports.rows,
});
wrote.push(path.relative(profile, machineFile));

console.log(`Exported ${src} → ${profile} (machine "${machine}"):`);
for (const f of wrote) console.log(`  ${f}`);
