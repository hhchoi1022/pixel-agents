# Office profile (WFM → other machines)

This build's custom office travels in two parts: the code (this fork; branch
rules in [`FORK.md`](../FORK.md)) and this `profile/` folder. The folder holds what lives in
`~/.pixel-agents/`, split into what's the same everywhere and what names one
machine's paths.

| Where                                                     | What                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `common/layout.json`, `common/agent-seats.json`           | The office as drawn on WFM (fix it on the new machine with the editor)                         |
| `common/config.json`                                      | Display options per surface (sound, labels, areas, …)                                          |
| `common/server-room.json`, `common/project-displays.json` | Where the racks and the project band sit                                                       |
| `common/ports.md`                                         | The web-page registry's header (rows are per machine)                                          |
| `machines/<name>.json`                                    | Directories, Area mappings, mounts, remote hosts, alert files, status-board folders, port rows |

Never in the profile: `standalone-token`, `server.json`, `servers/`,
`standalone-state.json`, `hooks/`, `*.bak*`, and hook consent. Each machine
mints its own token and asks for hook consent on first run.

## On the new machine (MCS)

Needs Node ≥ 20 and git.

```bash
git clone -b mcs https://github.com/hhchoi1022/pixel-agents.git pixel-agents-src
cd pixel-agents-src
npm install
node esbuild.js --production          # server + hook script → dist/
(cd webview-ui && npm run build)      # office UI → dist/webview/

# Fill in profile/machines/mcs.json first: Directories ({name, path}),
# areaMappings, serverRoom.mounts, projectDisplays, ports. Empty is fine:
# the office runs, it just shows no projects yet.
node scripts/import-profile.mjs --target mcs --dry-run   # see what it writes
node scripts/import-profile.mjs --target mcs             # backs up what it replaces

nohup node dist/cli.js --port 3456 > ~/pixel-agents.log 2>&1 &
```

Open the URL the log prints (it carries the token; treat it as a secret).
The intro asks for Claude hook consent once.

The import refuses to run while a Pixel Agents server is using the target
directory: a running server writes its in-memory layout back over the file.
Stop it, import, start it.

## Refreshing the profile from WFM

```bash
node scripts/export-profile.mjs --machine wfm
```

It rewrites `common/` and `machines/wfm.json` from `~/.pixel-agents` and
leaves other machines' files alone. Review the diff before committing.
`ports.md` rows are absolute paths on that machine, and `directories` points
at its checkouts.
