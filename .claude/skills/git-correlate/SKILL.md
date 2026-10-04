---
name: incident-bot-git-correlate
description: Chunk 4 on its own. Use when asked "what changed in <repo> before <time>", "which commit touched <Class.method>", or "recent merged PRs of <service>". Anchors on the service's last deployment, not on the alert window, and returns git.json with commits, merged PRs and frame hits. Read-only; never pushes, never opens PRs.
---

# incident-bot · git-correlate

Usage: `git-correlate --team <team> --repo <owner/name> --anchor <ISO> [--lookback-hours 48] [--frame 'Class.method(File.java:142)']`.

Follow `${REPO}/briefs/git-correlator.md` exactly, with a minimal context: `{ repo, deploy_anchor:{at}, frames:[…], service_name }`. Prefer the GitHub MCP read tools when the session has them; otherwise `scripts/github.mjs clone|recent|frame` on a shallow clone under the state dir's `repos/` folder. Print git.json and a short summary: anchor used and its source, number of commits and merged PRs in the lookback, and whether any of them touched the failing frame.
