import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, fixture } from "./helpers.mjs";

let env;
before(() => { env = setup(); });
after(() => env.teardown());

test("context: service, error id, window from the link, deploy anchor from the SRE reply, repo from the catalogue", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { buildContext, extractFacts } = await import("../scripts/context.mjs");
  const cfg = resolve("fixture");
  const hits = fixture("hits.json");
  const thread = hits.threads["1790000000.000001"];
  const cand = { ts: "1790000100.000100", threadTs: "1790000000.000001", channelId: "C0FIXTURE1", permalink: hits.hits[0].permalink, alertCode: "SRE0042", kibanaLinks: [], tagger: "UBOTSRE" };
  const facts = extractFacts(thread);
  assert.equal(facts.service, "pricing-service");
  assert.equal(facts.errorId, "2b06a360");
  assert.equal(facts.exception, "java.lang.NullPointerException");
  assert.equal(facts.deploy.release, "v1.42.0");

  const ctx = await buildContext(cfg, cand, thread);
  assert.equal(ctx.service_name, "pricing-service");
  assert.equal(ctx.error_id, "2b06a360");
  assert.equal(ctx.window_utc.from, "2026-10-04T07:50:00.000Z");
  assert.equal(ctx.window_utc.source, "link:discover");
  assert.equal(ctx.deploy_anchor.source, "sre-reply");
  assert.equal(ctx.deploy_anchor.at, new Date(1790000050.00005 * 1000 - 3 * 36e5).toISOString());
  assert.equal(ctx.repo_source, "none", "pricing-service is not in the catalogue fixture");
  assert.ok(ctx.gaps.some(g => /no repo mapping/.test(g)));
  assert.match(ctx.signature_hint, /NullPointerException at com\.auto1\.pricing/);
  assert.equal(ctx.thread_excerpt.length, 4);
});

test("context: QA-style alert yields service from 'Service name:' and a quoted title", async () => {
  const { extractFacts } = await import("../scripts/context.mjs");
  const f = extractFacts([{ ts: "1790000700.000700", user: "UALERTBOT", text: "'REM - ERROR rate - QA'\n\n<!subteam^S0FIXTURE01|fixture-be>\n\nDetails:\n- Timestamp: 2026-10-05T10:47:04.052Z\n- Hits: 1\nService name: remarketing-car\n<https://kibana.qa.services.auto1.team/goto/41e8286320510f7a3a82a425b842ad67|Kibana Discover Link>" }]);
  assert.equal(f.service, "remarketing-car");
  assert.equal(f.title, "REM - ERROR rate - QA");
  assert.match(f.links.kibana, /kibana\.qa\./);
});

test("context: a link the parser cannot read becomes a gap, never a crash", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { buildContext, lookupRepo } = await import("../scripts/context.mjs");
  const { parseDiscover } = await import("../scripts/links.mjs");
  const cfg = resolve("fixture");
  const bad = "https://kibana.qa.services.auto1.team/app/discover#/?_g=(time:(from:'2026-10-06T10:00:00.000Z',to:'2026-10-06T10:30:00.000Z'))&_a=(filters:!((meta:(key:service.name,params:(query:zrt-admin-dashboard),type:phrase),query:(match_phrase:(service.name:zrt-admin-dashboard))))";
  assert.throws(() => parseDiscover(bad), /expected/);
  const cand = { ts: "1790000800.000800", threadTs: "1790000800.000800", channelId: "C0FIXTURE1", alertCode: null, kibanaLinks: [bad] };
  const ctx = await buildContext(cfg, cand, [{ ts: "1790000800.000800", user: "UALERTBOT", text: "'REM - ERROR rate - QA'\nService name: zrt-admin-dashboard\n<" + bad + "|Kibana Discover Link>" }]);
  assert.equal(ctx.service_name, "zrt-admin-dashboard");
  assert.equal(ctx.window_utc.source, "fallback");
  assert.ok(ctx.gaps.some(g => /kibana link not resolved \(parse failed/.test(g)));
  assert.equal(lookupRepo("zrt-admin-dashboard", { services: { "zrt-admin-dashboard": { repo: "wkda/zrt-admin-dashboard-service" } } }, null).repo, "wkda/zrt-admin-dashboard-service");
});

test("context: fallback window when no link resolves, capped at maxWindowHours", async () => {
  const { resolve } = await import("../scripts/config.mjs");
  const { buildContext } = await import("../scripts/context.mjs");
  const cfg = resolve("fixture");
  const cand = { ts: "1790000500.000500", threadTs: "1790000500.000500", channelId: "C0FIXTURE1", alertCode: "SRE0043", kibanaLinks: [] };
  const ctx = await buildContext(cfg, cand, [{ ts: "1790000500.000500", user: "U1", text: "*[SRE0043]: Latency | margin-service*\nDetected for: *margin-service*" }]);
  assert.equal(ctx.window_utc.source, "fallback");
  assert.equal(Date.parse(ctx.window_utc.to) - Date.parse(ctx.window_utc.from), 60 * 60e3);
  assert.equal(ctx.repo, "wkda/margin-service", "short name resolves through the catalogue");
  const wideCand = Object.assign({}, cand, { kibanaLinks: ["https://kibana.prod.services.auto1.team/app/discover#/?_g=(time:(from:now-3d,to:now))"] });
  const wide = await buildContext(cfg, wideCand, [{ ts: "1790000500.000500", user: "U1", text: "x" }], { resolver: async () => ({ shape: "discover", from: "2026-10-01T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z" }) });
  assert.match(wide.window_utc.source, /capped/);
});
