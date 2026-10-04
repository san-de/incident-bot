# Onboarding a team

Time: one PR, one bootstrap run, one week of dry runs.

1. **Ids.** From a raw Slack message: the source channel id (`C…`), the user group id (`S…`, from a `<!subteam^S…|handle>` mention), the team channel id, the owner's user id. From Agent1: the team board id and the agent id (after `bootstrap.sh agents`, `agent1/bootstrap.sh status` or the UI shows it).
2. **Config.** `cp config/teams/_example.json config/teams/<team>.json`, fill every `REPLACE_…` value, set `enabled: true`, keep `output.dryRun: true` for now. `node scripts/config.mjs validate --team <team>` must pass. Open a PR; CI runs the same validation.
3. **Services.** Add the team's `service.name → repo` pairs to `config/services.json` in the same PR. Missing ones are discovered at run time into the overlay file and can be promoted later.
4. **Credentials.** Preferred: ask a platform admin for a service account `incident-bot-<team>` (GitHub PAT, Slack bot token invited to the two channels, read-only Elastic key, Delorean key). Fallback: the task owner saves a long-lived GitHub PAT and the Elastic key in Integrations and links Slack.
5. **Create.** `agent1/bootstrap.sh poll --team <team> --repo https://github.com/<owner>/incident-bot --ref v<VERSION> --extra-args "--dry-run" --notify`, then `agent1/bootstrap.sh watchdog --team <team>`.
6. **Watch a week.** The team channel shows nothing during a dry run; read the ledger (`ledger.mjs status`) and the run transcripts. Tune `skip.alertCodes`, `knownNoise`, `poll.maxPerRun`.
7. **Go live.** Set `output.dryRun: false` by PR, recreate the poll task without `--extra-args`, pause the dry-run task. Keep it as a reference for a week, then delete it.
8. **Jira, later.** Only after the analyses are trusted: `jira.enabled: true`, `jira.project`, `jira.createVia` by PR, and the automation from `agent1/automations/jira-create.json` when `webhook`.
