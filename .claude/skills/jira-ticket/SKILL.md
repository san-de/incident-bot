---
name: incident-bot-jira-ticket
description: Chunk 8. Use when asked to "create a Jira ticket for this alert", "file this in <PROJECT>", or as step 2 of the Agent1 jira-ticket workflow. Resolves the team's Jira project (asks once when not configured), searches for duplicates first, classifies bug vs task by rule table with a model fallback, proposes labels (asks once when interactive), then creates the issue through the path the team config names and reports the key back to the Slack thread. Never creates a duplicate; in unattended mode never asks.
---

# incident-bot · jira-ticket

Usage: `jira-ticket --team <team> [<PROJECT>] (<report.json> | <slack-permalink> | "<pasted text>") [--labels a,b] [--type Bug|Task]`.
Mode: **interactive** when a person is in the session; **unattended** inside `incident-bot-poll` or an Agent1 scheduled run. The two differ only in whether a question is allowed.

1. **Input.** A report.json from the pipeline is used as-is. A permalink → run `incident-bot-triage` up to Phase 5 (no posting) to get report.json and context.json. Pasted text → build a minimal context (`service_name`, `signature_hint`, `window_utc` = now ± 30 min) and a report with `classification: "unknown"`.
2. **Project.** `jira.project` from config, else the `<PROJECT>` argument. Interactive and still missing → ask once: "Which Jira project key (for example PRIC)?" and remember it by appending to the team overlay file. Unattended and missing → gap `jira project unknown`, stop this chunk. Validate the key with the Atlassian MCP project read when present.
3. **Dedupe.** `node ${REPO}/scripts/jira.mjs jql --team <team> --report report.json --context context.json` → run that JQL with the Atlassian MCP search tool (or the Agent1 automation `jira.search` when the session has none). A hit with the same error.id or signature → comment on it (interactive: via MCP if a comment tool exists, else tell the person), link it in the Slack thread, `post.mjs mark --ticket <KEY>`, stop. No classification, no labels, no new ticket.
4. **Classify.** `node ${REPO}/scripts/jira.mjs classify --team <team> --report report.json`. `decided_by: rule` → use it. `model-needed` → decide Bug or Task yourself in one line of reasoning; interactive → show it and let the person override; unattended → use it and record `decided_by: model` in the ticket's gaps.
5. **Labels.** Propose `jira.labels` + `service:<name>` + labels in the project that match the service (`jira.mjs payload` prints the proposal). Interactive → ask once: "Labels for the ticket? (proposed: …)". Unattended → use the proposal.
6. **Create.** `node ${REPO}/scripts/jira.mjs payload … [--labels …] [--type …]` → payload.json, then `node ${REPO}/scripts/jira.mjs create --team <team> --payload payload.json`.
   `createVia: webhook` → the script posts to the Agent1 automation; its response carries the key.
   `createVia: mcp` → the script prints the payload; call the Atlassian create-issue tool with `project_key`, `issue_type`, `summary`, `labels`, and `description_text`.
   `createVia: none` → report the payload and stop.
7. **Report.** Append `Filed <KEY>: <url>` to the alert thread (through `post.mjs check` first), `post.mjs mark --ts <cand ts> --status posted --ticket <KEY>`, write ticket.json. In an Agent1 workflow end with `complete_step_and_advance` naming the key.

Jira writes on Agent1: the system Atlassian MCP is read-only and automations have no create action yet. Until one exists, `webhook` points at a team automation whose HTTP step calls the Jira REST API with a token kept in that automation's Secrets panel.
