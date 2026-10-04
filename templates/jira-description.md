# Jira description — rendered from fixed fields, never from model prose

Rendered by `scripts/render.mjs jira` and sent as `description_text` in the create payload. The automation (or MCP tool)
converts it to ADF. Every ticket has the same shape so a reader can scan the backlog.

```text
h3. Alert
*Service:* {{service}}
*Alert:* [{{alert_code}}] {{title}}
*Classification:* {{classification}}
*Window (UTC):* {{window}}
*Occurrences in window:* {{count}}
*Signature:* {{signature_line}}

h3. What happens
{{what}}

h3. Read
{{read}}

h3. Where
{{where}}

h3. Recent change
{{suspect}} (last deploy {{last_deploy}})

h3. Proposal
{{proposal}}

h3. Links
Slack thread: {{thread_permalink}}
Kibana: {{links.kibana}}
{{#if links.grafana}}Grafana: {{links.grafana}}
{{/if}}{{#if links.jenkins}}Jenkins: {{links.jenkins}}
{{/if}}
h3. Gaps
{{gaps}}

_Filed by incident-bot for team {{team}}. Evidence and counts come from Kibana aggregations; the classification follows the team rule table._
```
