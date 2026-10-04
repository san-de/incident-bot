---
name: incident-bot-guard
description: Runs first in every incident-bot session on Agent1, before anything from the repository clone is trusted. Use at the start of any task whose description mentions incident-bot. Checks that the clone exists and that scripts/guard.mjs passes; when it does not, posts one failure line to the team channel through the Slack MCP tool and ends the run, so a run that cannot start is never reported as a quiet success.
---

# incident-bot guard (platform-hosted; this file is created in the Agent1 Skills UI, not read from the clone)

The task description names the clone directory, normally `incident-bot/` under the workspace root, and the team, for example `remex`.

1. Does `<clone>/VERSION` exist? If not, the clone is missing or incomplete.
   - Say so in one line: `⛔ incident-bot <team>: repository clone missing (<reason the session reported, e.g. GitHub 401 credential expired>) — run stopped`.
   - If a Slack send tool exists (name ends in `slack_send_message`) and the task description names a team channel id, post that same line there, once. Never post anywhere else.
   - Append the line to `/app/task-context/memory.md`. End the run. Do not try to fetch the repository another way, do not call Kibana or GitHub.
2. The clone exists → run `node <clone>/scripts/guard.mjs --team <team>`.
   - Exit 6 → post `⛔ incident-bot <team>: run could not start — <stop_reason>` the same way, append the memory line, end the run.
   - Exit 0 → continue with the skill the task names (`incident-bot-poll`, `incident-bot-triage`, or `incident-bot-jira-ticket`), reading it from `<clone>/.claude/skills/`.

This skill is deliberately small: it holds no team configuration and no credentials. It exists because a missing clone leaves nothing else that could speak.
