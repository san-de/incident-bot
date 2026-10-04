---
name: incident-bot-slack-scan
description: Chunk 1 on its own. Use when asked "what did <team> get tagged on since <when>", "list new rota tags for <team>", or to dry-run the scan without triaging. Fetches Slack search and thread data with the Slack MCP tools and runs scripts/match.mjs to produce candidates.json. Read-only, writes nothing, not even the ledger.
---

# incident-bot · slack-scan

Usage: `slack-scan --team <team> [--since 3d|12h]`. `${REPO}` is this repo's clone.

1. `node ${REPO}/scripts/config.mjs resolve --team <team>` → CFG. `effectiveStart` = `now − since` when given, else `min(now − poll.sinceFallbackMinutes, ledger watermarkTs)` (read via `ledger.mjs status`, which does not write).
2. Run Phase 1 steps 2 to 4 of `incident-bot-poll` (search per channel × term with `include_bots=true`, read every hit's thread, read the channel for un-indexed parents, write hits.json).
3. `node ${REPO}/scripts/match.mjs --team <team> --file hits.json` and print the result: a table of candidates (local time, alert code, service guess from the thread, permalink) and a count of skipped by reason.
4. Mark nothing, advance nothing. Say explicitly: "dry scan, ledger untouched".
