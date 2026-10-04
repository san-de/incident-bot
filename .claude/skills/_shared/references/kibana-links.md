# Kibana link shapes seen in #bot_rota and how to turn each into an AlertContext

Target: `{ service, from_utc, to_utc, errorId?, kql?, levels?, traceId?, resolvedUrl }`. Always HTML-unescape Slack text first (`&amp;` → `&`, `&lt;`/`&gt;`), strip the Slack wrapper `<url|label>` → `url`, and percent-decode (`%7C%7C` → `||`, `%2F` → `/`).

## Shape 1 — Full Discover URL (posted by the `sre` bot and the Kibana Alerts app)

```
https://kibana.prod.services.auto1.team/app/discover#/?_g=(filters:!(),refreshInterval:(pause:!t,value:1000),time:(from:'2026-09-07T16:00:57.185Z||-30m',to:'2026-09-07T16:00:57.185Z'))&_a=(columns:!(service.name,log.level,message,trace.id,error.stack_trace,error.id),dataSource:(dataViewId:'*beat-*',type:dataView),filters:!(('$state':(store:appState),meta:(alias:!n,disabled:!f,index:'*beat-*',key:error.id,negate:!f,params:(query:'246c1db7'),type:phrase),query:(match_phrase:(error.id:'246c1db7'))),('$state':(store:appState),meta:(…,key:service.name,…,params:(query:'public-remarketing'),type:phrase),…)),…)
```
Legacy form: `…/app/kibana#/discover?_g=(…time:(from:'2026-05-12T09:45:02.449509Z',mode:absolute,to:'2026-05-12T10:17:02.449509Z'))&_a=(…filters:!(('$state':…,meta:(…key:service.name,…params:(query:visibility-restriction),type:phrase)…),('$state':…,meta:(…key:log.level,…params:!(ERROR,CRITICAL,ALERT),type:phrases…)…)),query:(language:kuery,query:''),…)`

Rison is read by hand — no library needed for these fields:
- `_g` → `time:(from:'…',to:'…')`. Absolute ISO → use as is. `'<ISO>||-30m'` = anchor minus 30 min → `from = anchor - 30m`. `now-15m`/`now` → relative to the **message time**, not to now.
- `_a` → every `filters:!((…))` element: `meta:(key:<field>, params:(query:<value>) | params:!(<v1>,<v2>), type:phrase|phrases, negate:!f|!t)`. Take `service.name`, `error.id`, `log.level` (list), `trace.id`, `host.name`. Unquoted rison strings have no quotes (`query:visibility-restriction`); quoted ones use `'…'`. Ignore `negate:!t` filters except to note them.
- `_a` → `query:(language:kuery,query:'<KQL>')` → `kql` when non-empty.
- `columns` and `grid` are irrelevant.

## Shape 2 — Short link (posted by humans)

```
https://kibana.prod.services.auto1.team/app/r/s/tgRnv
```
Resolve through Kibana's short-URL API with the bundled script (key from the environment or the kibana plugin's key file, never printed):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/links.mjs short" '<short url or slug>' --env prod
```
Exit codes: `2` no key, `3` unreachable (VPN), `4` auth, `5` unknown/expired slug, `0` ok with JSON `{ id, resolvedUrl, locatorId, state, embeddedUrl? }`.
Response: `{ "id", "slug", "locator": { "id": "DISCOVER_APP_LOCATOR" | "LEGACY_SHORT_URL_LOCATOR", "state": { … } } }`.
- `DISCOVER_APP_LOCATOR` state: `timeRange:{from,to}`, `filters:[{meta:{key,params:{query}},query:{match_phrase:{<field>:<value>}}}]`, `query:{language,query}`, `dataViewId`. Map exactly like Shape 1.
- `LEGACY_SHORT_URL_LOCATOR` state: `{ "url": "/app/discover#/?_g=…&_a=…" }` → the script returns it absolute as `embeddedUrl`; parse it as Shape 1 with `links.mjs discover`.
- `resolvedUrl` for the reply = `https://kibana.prod.services.auto1.team/app/r/s/<id>` (keep the short one; it is what the human shared).
Failure modes: exit `3` → VPN or network → Gaps: `short link <id> not resolved (Kibana unreachable)`; exit `2`/`4` → key missing/expired → Gaps: `short link not resolved (auth)`; exit `5` → the slug is unknown to Kibana (short links expire; verified 2026-09-07: the May link `tgRnv` returns 404 while `/api/status` returns 200 with the same key) → Gaps: `short link expired`. In all cases fall back to the thread's Shape 1 link for service and window.

## Shape 3 — Locator link with lz-string payload (Kibana ≥ 8.x alert actions)

```
https://kibana.prod.services.auto1.team/app/r?l=DISCOVER_APP_LOCATOR&v=9.4.2&lz=N4IgJghgLhBqCWBTA7gZQA6IMYgFynjDxABYBmAVhIAYAjLWgWgmrEUZIDZamAOCgEy9G…
```
`lz` = lz-string compressed JSON of the locator state — Kibana 9.x uses `compressToBase64` (URL-encoded, so you see `%2B` `%2F` `%3D`), older links used `compressToEncodedURIComponent`. Decode with the bundled dependency-free script, which detects the alphabet and accepts the whole URL or just the value:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/links.mjs lz" '<full locator URL, Slack-escaped is fine>'
```
Verified 2026-09-07 against a live `#gen-ai-prod-incidents` link: output was `{ dataViewSpec.title: "logs-auto1.services-*", filters[0].meta.value: 'organization.team: "gen-ai" AND log.level: "error"', timeRange: {from, to}, isAlertResults: true }`.

The output is the locator state JSON: `timeRange.{from,to}`, `filters[].meta.{key,value}` (for `type: query_string` the KQL/Lucene text is in `meta.value`), `query.query`, `dataViewSpec.title`. Alert-generated links filter by `organization.team` and `log.level`, not by `service.name` — take the service from the Slack message (`- Service: <name>`) instead. Slack sometimes truncates long `lz` values with `…` — a truncated payload cannot be decoded; Gaps: `locator link truncated by Slack`, fall back to the thread's Shape 1 link.

## Other links in the same threads (not Kibana, but useful)

- Grafana `…/d/000000088/service-metrics-dashboard?…&var-service=<service>-service&from=<ms>&to=<ms>` → the `from`/`to` epoch-ms are another source for the window.
- Jenkins `…/job/java/job/<group>/job/<service>-service/job/deploy/<n>/` and GitHub `…/<repo>/releases/tag/<X.Y.Z>` → repo name and deployed release tag for Phase 4.
- Jira `https://wkdauto.atlassian.net/browse/SI-<n>` → the incident ticket to quote in the reply.
