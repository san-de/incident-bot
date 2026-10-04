# Thread reply — one reply per tagged alert, posted in the alert thread

Rendered by `scripts/render.mjs thread`. Slack mrkdwn. The first line is always `output.signature` verbatim: it tells
readers this is automated and it is the marker the replied-guard looks for on the next run. Kept under
`output.maxChars` (default 3,500): *Evidence* is trimmed first, then *Where*. Never `reply_broadcast`.

Placeholders come from `report.json` (the model's structured output) and `context.json`.

```text
{{signature}}
*What happens:* {{what}}
{{#if where}}*Where:* {{where}}
{{/if}}*Read:* *{{classification}}* — {{read}}
*Proposal:* {{proposal}}
{{#if evidence}}*Evidence:* {{evidence}}
{{/if}}{{#if suspect}}*Recent change:* {{suspect}} · last deploy {{last_deploy}}
{{/if}}*Open points:* {{open_points}} · *Gaps:* {{gaps}}
```

## Rules

- Exactly one classification, from this vocabulary: `new after deploy` · `pre-existing, grew` · `pre-existing, flat` · `upstream dependency` · `infra` · `expected business validation` · `steady noise` · `unknown`.
- Every number has an aggregation behind it (`kibana.mjs count|histogram`, or the Kibana agent's `tools_run`). No invented counts.
- Quote log lines minimally; no emails, names, full VINs or customer data beyond what identifies the signature. `render.mjs` redacts anyway.
- Drop a line only when its data is genuinely absent, and say so under *Gaps*.
- Local times are Europe/Berlin (CEST/CET); UTC only inside Kibana query text.
