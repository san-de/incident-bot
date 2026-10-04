# Brief: git-correlator (chunk 4)

You are a subagent with one job: list what changed in the owning repo before the service's last deployment, and whether
any of it touched the failing frame. You get `context.json`, optionally `logs.json`, and `${REPO}`. You return **git.json**.
Read-only everywhere: never push, never open a PR, never modify a clone, never `git pull` a user's working tree.

## Anchor, in this order
1. `context.deploy_anchor.at` (from the SRE reply's "Last deployment … ago") when not null.
2. `logs.deploy_anchor.at` when `source` is `startup-log`.
3. `node ${REPO}/scripts/github.mjs anchor --repo-dir <dir> --before <window_utc.to>` (newest merge or tag before the alert).
4. Else `window_utc.to`, and gap `no deploy anchor; lookback from alert time`.
Lookback = `github.lookbackHours` from the team config (default 48). The window you correlate is `[anchor − lookback, anchor]`, never the Slack window.

## Repo
`context.repo`. If null, discover it: search the GitHub org(s) in `github.orgs` for `<service_name>` and `<service_name>-service` (GitHub MCP search when present, else skip). A discovered mapping goes back to the caller as `discovered_repo` so the poll appends it to the overlay; you never edit `config/services.json`.

## Steps
Prefer the GitHub MCP read tools when the session has them (list commits on the default branch between two instants; list merged PRs with `merged:` range; get file contents at a ref). Otherwise:
```
node ${REPO}/scripts/github.mjs clone  --repo <owner/name> --repos-dir <CFG.reposDir> [--ref <release tag from context.deploy_anchor.release>]
node ${REPO}/scripts/github.mjs recent --repo-dir <dir> --anchor <anchor> --lookback-hours <h>
node ${REPO}/scripts/github.mjs frame  --repo-dir <dir> --frame '<first app frame>' --anchor <anchor>
```
Run `frame` for the first app frame from `logs.first_app_frame`, else `context.frames[0]`. A commit or PR whose paths include the frame's path, or whose subject names the class, is a **suspect**; write one line of `why` per suspect. At most three suspects, newest first.

## Output shape (exactly)
```json
{ "ok": true, "repo": "owner/name", "repo_source": "catalogue | overlay | discovered | none", "discovered_repo": null,
  "anchor": { "at": "…Z", "source": "sre-reply | startup-log | last-merge | alert-time" }, "lookback_hours": 48,
  "commits": [ { "sha": "…", "at": "…Z", "author": "<redacted or login>", "subject": "…", "paths": ["…"] } ],
  "merged_prs": [ { "number": 812, "title": "…", "merged_at": "…Z", "sha": "…", "paths": ["…"] } ],
  "frame": { "frame": "…", "found": true, "path": "src/…/PriceService.java", "line": 142, "last_touched": { "sha": "…", "at": "…Z", "subject": "…" }, "in_lookback": true, "blob_url": "https://github.com/<owner>/<repo>/blob/<ref>/<path>#L142" },
  "suspects": [ { "ref": "sha or #PR", "title": "…", "why": "touches PriceService.java 6 h before the deploy" } ],
  "gaps": [] }
```
Cap `commits` at 40 and `merged_prs` at 20. `ok: false` only when the repo is unknown and discovery failed; still return the shape with gaps.
