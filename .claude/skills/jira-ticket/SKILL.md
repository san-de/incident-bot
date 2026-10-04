---
name: incident-bot-jira-ticket
description: Chunk 8. Use when asked to "create a Jira ticket for this alert", "file this in <PROJECT>", or as step 2 of the Agent1 jira-ticket workflow. Resolves the team's Jira project (asks once when not configured), searches for duplicates first, classifies bug vs task by rule table with a model fallback, proposes labels (asks once when interactive), then creates the issue through the path the team config names and reports the key back to the Slack thread. Never creates a duplicate; in unattended mode never asks.
---

# incident-bot · jira-ticket

Usage: `jira-ticket --team <team> [<PROJECT>] (<report.json> | <slack-permalink> | "<pasted text>") [--labels a,b] [--type Bug|Task]`.
Mode: **interactive** when a person is in the session; **unattended** inside `incident-bot-poll` or an Agent1 scheduled run. The two differ only in whether a question is allowed.

1. **Input.** A report.json from the pipeline is used as-is. A permalink → run `incident-bot-triage` up to Phase 5 (no posting) to get report.json and context.json. Pasted text → build a minimal context (`service_name`, `signature_hint`, `window_utc` = now ± 30 min) and a report with `classification: "unknown"`.
2. **Project.** `jira.project` from config, else the `<PROJECT>` argument. Interactive and still missing → ask once: "Which Jira project key (for example PRIC)?" and remember it by appending to the team overlay file. Unattended and missing → gap `jira project unknown`, stop this chunk. Validate the key with the Atlassian MCP project read when present.
3. **Dedupe, three layers, all must be clear before anything is created.**
   a. Local: `node ${REPO}/scripts/jira.mjs local --team <team> --context context.json --report report.json`. It scans the ledger for tickets this bot already filed for the same thread, the same error.id, or the same exception signature in the last 30 days. `create_allowed: false` → reuse that ticket: link it in the Slack thread, `post.mjs mark --ticket <KEY>`, stop.
   b. Jira: `node ${REPO}/scripts/jira.mjs jql …` → run that JQL with the Atlassian MCP search tool (or the automation's `jira.search`). A hit with the same error.id or signature, in any status but Done → comment on it when a comment tool exists, link it in the thread, `post.mjs mark --ticket <KEY>`, stop. No Jira search tool available and layer a was clear → in unattended mode do **not** create (gap `no Jira search tool; dedupe incomplete`); in interactive mode tell the person and let them decide.
   c. At create time: the payload carries `idempotency_key` (`incident-bot:<team>:<thread_ts>`) and `dedupe_jql`; the automation searches both before creating and returns the existing key instead of a new one. A retried call therefore never files twice.
   After a successful create, always `post.mjs mark --ticket <KEY> --error-id <id> --service <name> --signature "<exception>"` so layer a knows about it next time.
4. **Classify.** `node ${REPO}/scripts/jira.mjs classify --team <team> --report report.json`. `decided_by: rule` → use it. `model-needed` → decide Bug or Task yourself in one line of reasoning; interactive → show it and let the person override; unattended → use it and record `decided_by: model` in the ticket's gaps.
5. **Labels.** Propose `jira.labels` + `service:<name>` + labels in the project that match the service (`jira.mjs payload` prints the proposal). Interactive → ask once: "Labels for the ticket? (proposed: …)". Unattended → use the proposal.
5b. **Epic (quarterly).** `node ${REPO}/scripts/jira.mjs epic --team <team> --type <Bug|Task> --context context.json`. `mode: pinned` → the quarter has a fixed key in `jira.epic.pins` (Q4 2026 → REMEX-3028 for remex); use `epic_key` directly, no search. Otherwise `epic_name` is built from the alert date (`BUG Q4 2026` for October to December 2026, `BUG Q1 2027` from January) and `epic_jql` finds it. Run the JQL with the Atlassian MCP search tool (or the automation's `jira.search`): the issue whose summary equals `epic_name` is the parent; pass its key as `--epic-key` in the next step. No match → follow `on_missing`:
   - `create-epic` (remex): create the epic from the `epic_create` object (issue type Epic, summary exactly `epic_name`, its description and labels) through the same path as tickets (`createVia`: the automation does it inside the same call; `mcp`: the Atlassian create tool with issuetype Epic). Search `epic_jql` once more right before creating, so two runs in the same minute do not both create one. Use the returned key as `--epic-key`, say in the thread reply `created epic <KEY> "<epic_name>"`, and record it in the ledger run note. Never create an epic for a pinned quarter.
   - `skip`: do not create the ticket; say in the thread reply and in gaps `epic "<epic_name>" not found in <PROJECT>, create it and re-run`.
   - `create-without-epic`: create the ticket and record the gap.
   Never guess an epic key and never fall back to last quarter's epic.
6. **Create.** `node ${REPO}/scripts/jira.mjs payload … [--labels …] [--type …] [--epic-key <KEY>]` → payload.json, then `node ${REPO}/scripts/jira.mjs create --team <team> --payload payload.json`.
   `createVia: webhook` → the script posts to the Agent1 automation; its response carries the key.
   `createVia: mcp` → the script prints the payload; call the Atlassian create-issue tool with `project_key`, `issue_type`, `summary`, `labels`, and `description_text`.
   `createVia: none` → report the payload and stop.
7. **Report.** Append `Filed <KEY>: <url>` to the alert thread (through `post.mjs check` first), `post.mjs mark --ts <cand ts> --status posted --ticket <KEY>`, write ticket.json. In an Agent1 workflow end with `complete_step_and_advance` naming the key.

Jira writes on Agent1: the system Atlassian MCP is read-only and automations have no create action yet. Until one exists, `webhook` points at a team automation whose HTTP step calls the Jira REST API with a token kept in that automation's Secrets panel.
