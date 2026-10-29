# This fork's branches

`hhchoi1022/pixel-agents` is a fork of
[`pixel-agents-hq/pixel-agents`](https://github.com/pixel-agents-hq/pixel-agents)
carrying the office run on the lab machines. Kept out of `README.md` so
official updates merge without conflicts.

| Branch   | What                                                                    |
| -------- | ----------------------------------------------------------------------- |
| `main`   | The official repo, untouched. Moved only by fast-forward, never forced. |
| `common` | The custom office both machines share. Every shared change goes here.   |
| `wfm`    | `common` + anything only WFM needs. The WFM server runs from this.      |
| `mcs`    | `common` + anything only MCS needs. Clone this on MCS.                  |

Rules:

- **Shared fix or feature**: commit on `common`, then merge `common` into
  `wfm` and `mcs`.
- **Official update**: fast-forward `main` from upstream, merge `main` into
  `common`, then `common` into `wfm` and `mcs`.
- **Machine differences are settings first.** Paths, hosts, mounts, alert
  files and port rows live in `profile/machines/<name>.json`, applied with
  `node scripts/import-profile.mjs --target wfm|mcs` (see
  [`profile/README.md`](profile/README.md)). Code goes on `wfm` or `mcs` only
  when a feature itself differs. Features that only one machine uses today
  (the BRIDGE alert yard, the LYMAN remote rack) stay on `common` and are
  switched by that machine's settings.

```bash
# official update
git fetch origin && git switch main && git merge --ff-only origin/main
git switch common && git merge main
git switch wfm && git merge common
git switch mcs && git merge common
```
