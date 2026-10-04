---
name: incident-bot-log-correlate
description: Chunk 3 on its own. Use when asked "what do the logs say for <service> between <from> and <to>", "count this error.id", or "find the deploy time of <service>". Combines the PROD Kibana App-Debugging agent (when present) with the deterministic scripts/kibana.mjs lookup and returns logs.json with real counts, a signature and a deploy anchor. Read-only.
---

# incident-bot · log-correlate

Usage: `log-correlate --team <team> --service <name> --from <ISO> --to <ISO> [--error-id x] [--trace-id y] [--text "NullPointerException"]`.

Follow `${REPO}/briefs/log-correlator.md` exactly, with a minimal context: `{ service_name, window_utc:{from,to}, error_id, trace_id, signature_hint }`. Print logs.json and a three-line human summary (count and baseline, signature with first app frame, deploy anchor and its source). Every number comes from `kibana.mjs count|histogram` or a Kibana-agent aggregation; no invented counts.
