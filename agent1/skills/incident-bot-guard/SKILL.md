---
name: incident-bot-guard
description: Runs first in every incident-bot session on Agent1, before anything from the repository clone is trusted. Use at the start of any task whose description mentions incident-bot. Checks that the clone exists and that scripts/guard.mjs passes; when it does not, posts one failure line to the team channel through the Slack MCP tool (at most once per 6 hours for the same reason) and ends the run, so a run that cannot start is never reported as a quiet success.
---

# incident-bot guard (platform-hosted; this file is created in the Agent1 Skills UI, not read from the clone)

The task description names the clone directory, normally `incident-bot/` under the workspace root, and the team, for example `remex`.

1. Does `<clone>/VERSION` exist? If not, the clone is missing or incomplete.
   - Compose one line: `⛔ incident-bot <team>: repository clone missing (<reason the session reported, e.g. GitHub 401 credential expired>) — run stopped`. If the session reported a GitHub 401 or "credential expired", add: `fix: Integrations → GitHub → Advanced → save a long-lived PAT (OAuth expires daily), or run as a service account`.
   - **Repeat limit.** Run `tail -n 12 /app/task-context/memory.md` (ignore if missing). If a line from the last 6 hours already contains `gaps=clone-missing` or `gaps=guard:`, do NOT post to Slack again; only append the memory line (step 1's last bullet) and end the run. Otherwise post the line once to the team channel id named in the task description, if a Slack send tool exists (name ends in `slack_send_message`). Never post anywhere else.
   - In a workflow step: additionally `append_to_task_context` with action `blocked` and the question "The repository clone is missing (<reason>). Fix the GitHub credential (Integrations → GitHub → Advanced → PAT) and restart this step." Then stop.
   - Append `<ISO time> <team> candidates=0 posted=0 skipped=0 failed=0 gaps=clone-missing (<reason>)` to `/app/task-context/memory.md`. End the run. Do not try to fetch the repository another way, do not call Kibana or GitHub, and never create anything in Jira or Slack as a substitute for the skill.
2. The clone exists → run `node <clone>/scripts/guard.mjs --team <team>`.
   - Exit 6 → the same handling with `⛔ incident-bot <team>: run could not start — <stop_reason>` and `gaps=guard:<first failing check>`.
   - Exit 0 → continue with the skill the task names (`incident-bot-poll`, `incident-bot-triage`, or `incident-bot-jira-ticket`), reading it from `<clone>/.claude/skills/`.

This skill is deliberately small: it holds no team configuration and no credentials. It exists because a missing clone leaves nothing else that could speak.
