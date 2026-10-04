# Operations runbook

All commands run from the repo root. `AGENT1_API_KEY` is the operator's personal Agent1 key; it is read from the
environment only and never printed. Without a key, the same API calls work from a logged-in browser tab on
agent1.prod.apps.auto1.team with `fetch('/api/…', {credentials:'include'})`.

## REMEX objects (created 2026-10-04, browser route)

| Object | Id |
|---|---|
| Skill `incident-bot-guard` (restricted) | `9c802e17-92f3-4cb0-aa41-539fb38baeee` |
| Agent `incident-bot` (private during dry-run) | `34c99c2a-7069-4ec0-b8ea-184ce2dff1b0` |
| Agent `incident-bot-log-correlator` | `6544c761-41c9-4a3e-9555-628167755f47` |
| Agent `incident-bot-git-correlator` | `bc7c3a19-c1e2-44be-b464-6791358a6296` |
| Agent `incident-bot-jira-classifier` | `d558a0d0-9bcb-40bb-9657-909051340dd9` |
| Agent `incident-bot-watchdog` (human-owned, agent1-mcp) | `c471d1cd-da07-4989-8435-d8aee46ed185` |
| Workflow `incident-bot · triage-one` | `46e5c3b6-8565-4fb6-90f3-b2c5f6e38c47` |
| Workflow `incident-bot · jira-ticket` | `d25f765c-90b4-4513-b01d-aab1a3c7fcfe` |
| Task `incident-bot · poll · remex` — hourly, **dry-run**, project san-de/incident-bot@main, notify on | `10da65be-3f6f-4323-8642-7c4a28915457` |
| Task `incident-bot · watchdog · remex` — daily 08:30 Berlin | `53b49a97-bcc5-4137-8cc0-76c416740bc6` |
| Previous bot: task `rota-triage · remex` (still scheduled hourly; pause it once the dry run is trusted) | `b776259b-049b-4692-ba15-e7fa61e42df4` |

## Objects per team

| Object | Created by | Notes |
|---|---|---|
| Agent `incident-bot` (+ 3 step agents) | `bootstrap.sh agents` | public, sonnet, unrestricted, kibana plugin, default skill `incident-bot-guard` |
| Skill `incident-bot-guard` | `bootstrap.sh skill` | platform-hosted; share with the team or make public |
| Workflows `triage-one`, `jira-ticket` | `bootstrap.sh workflows` | step 2 never auto-starts (human gate) |
| Task `incident-bot · poll · <team>` | `bootstrap.sh poll` | hourly, project = this repo at a tag, notify on |
| Task `incident-bot · watchdog · <team>` | `bootstrap.sh watchdog` | daily, human-owned (needs agent1-mcp), posts only when unhealthy |
| Automation `incident-bot · jira-create` | UI, from `agent1/automations/jira-create.json` | only when `jira.createVia: webhook` |

## See what the bot did

- Ledger: `node scripts/ledger.mjs status --team <team>` (locally `~/.claude/incident-bot/<team>/ledger.json`; on Agent1 `/app/task-context/incident-bot/<team>/ledger.json` from inside a task).
- Task and runs: `agent1/bootstrap.sh status <taskId>`: schedule state, next run, last runs with status, cost and duration.
- Reading durations: ~25 s and ~$0.13 means the run stopped before Phase 1 (clone or guard). 3 to 5 minutes is an empty poll. Over $0.50 means candidates were analysed.
- Team channel: every handled alert produces one post; a `⛔ incident-bot <team>: run could not start` line means the guard stopped a run; a `🩺` line comes from the watchdog.

## Pause, resume, run now

```
agent1/bootstrap.sh disable <taskId>
agent1/bootstrap.sh enable  <taskId>
agent1/bootstrap.sh run-now <taskId>
```

## Re-triage a thread, backfill

The watermark only moves forward. To re-process something, run a one-off task (or locally) with an explicit scope:
`triage --team <team> <permalink>` handles exactly one message; `poll --team <team> --since 3d --dry-run` ignores the
watermark. Both refuse to re-post into a thread the ledger already lists under `repliedThreads`; delete that key from the
ledger JSON (from inside a task on Agent1) if a repost is really wanted. The staleness rule (`skip.olderThanHours`, 48)
still applies to a backfill; raise it in config for one run if older alerts must be analysed.

## Release

1. Bump `VERSION`, merge, tag `v<VERSION>`.
2. Recreate the poll task with `--ref v<VERSION>` (or edit the task's project branch in the UI). Tasks pinned to `main` pick up the next run automatically.
3. Changed `agent1/agents/*.json` or the guard skill → rerun `bootstrap.sh agents` / `bootstrap.sh skill`. Workflows are immutable in practice: create a new one and move the sync rule or board to it.

## Rotate credentials or move to a service account

Service account path (preferred): a platform admin creates `incident-bot-<team>` with a GitHub PAT, Slack bot token (invited
to the source and team channels only), read-only Elastic key and Delorean key, registered in the credential catalog so
rotation happens once. Set `agent1.runAs` and `agent1.serviceAccount` in the team config, recreate the poll task as the
account. Personal path (fallback): save a long-lived GitHub PAT under Integrations → GitHub → Advanced; the Kibana key
under Integrations → Elastic; relink Slack when it expires.

## Failure signatures

| Symptom | Likely cause | Fix |
|---|---|---|
| `⛔ … repository clone missing (GitHub 401)` | task owner's GitHub credential expired or repo not reachable through the proxy | re-save the PAT, or move to the service account; the repo must be public or in an org the proxy allows |
| `⛔ … run could not start — config: …` | team config invalid at that tag | fix config, release |
| Runs end with `Slack search tool missing` | agent has no Slack MCP or the Slack link expired | relink Slack; check the agent's `mcpBindings.slack` |
| `kibana: none` in preflight gaps | no Elastic key for the runner | save the key in Integrations or on the service account |
| Thread replies fail, team posts carry the full analysis | runner cannot post into the source channel | the runner (bot) must be a member of the channel |
| Watchdog says `not starting` | every run under 60 s | read the latest run's transcript; usually the clone |
| Task shows `timed_out` runs | > 2 h per run | lower `poll.maxPerRun`; check Kibana latency |
