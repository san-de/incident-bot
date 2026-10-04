---
name: incident-bot-triage
description: Triage exactly one Slack alert by permalink for a team, with the same chunks as the poll (context → logs ‖ git → synthesize → post). Use when asked to "triage this alert", "analyse this Kibana alert from bot_rota", "re-run this thread", or given a Slack permalink and a team. Does not advance the watermark. Refuses to re-post into a thread the ledger already lists.
---

# incident-bot · triage one alert

Usage: `triage --team <team> <slack-permalink> [--dry-run]`. `${REPO}` is this repo's clone.

1. `node ${REPO}/scripts/guard.mjs --team <team>`; exit 6 → stop with the reason.
2. Parse the permalink: `…/archives/<CHANNEL>/p<digits>[?thread_ts=…]` → `ts` = digits with a `.` before the last 6; `thread_ts` from the query or the message itself.
3. `slack_read_thread channel_id=<CHANNEL> message_ts=<thread_ts>` → the thread. Build a one-hit `hits.json` and run `match.mjs --team <team> --file hits.json`. If the message is skipped as "already replied" and the user did not say to force, stop and say which reply exists. Other skip reasons (stale, non-alert) are ignored for an explicit permalink: continue with the hit as the candidate.
4. Phases 1b to 6 of `incident-bot-poll` for that single candidate (preflight, `context.mjs`, the two briefs in parallel, report.json, `post.mjs plan` → send → `post.mjs mark`).
5. Do **not** advance the watermark. `ledger.mjs run-note` with `{"mode":"triage-one","candidates":1,…}`.
6. If `jira.enabled`, offer nothing automatically here; the Jira flow for a single alert is the `incident-bot-jira-ticket` skill, which may ask.

In an Agent1 workflow this skill is step 1 ("Analyze"). End the step by appending report.json to the task context (`append_to_task_context` with the report under `result`), then `complete_step_and_advance` with the one-line read.
