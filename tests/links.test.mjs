import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiscover, rison, absTime, decodeLz, unslack } from "../scripts/links.mjs";

test("rison parses nested objects, arrays and quoted strings", () => {
  assert.deepEqual(rison("(a:1,b:!t,c:!(x,y),d:'it!'s')"), { a: 1, b: true, c: ["x", "y"], d: "it's" });
});

test("parseDiscover extracts window and filters from a Slack-escaped URL", () => {
  const url = "<https://kibana.prod.services.auto1.team/app/discover#/?_g=(time:(from:'2026-10-04T07:50:00.000Z',to:'2026-10-04T08:20:00.000Z'))&amp;_a=(filters:!((meta:(key:service.name,params:(query:pricing-service)),query:(match_phrase:(service.name:pricing-service))),(meta:(key:error.id,params:(query:'2b06a360')),query:(match_phrase:(error.id:'2b06a360')))),query:(query:'log.level:ERROR'))|:evil_kibana:>";
  const r = parseDiscover(url);
  assert.equal(r.service, "pricing-service");
  assert.equal(r.errorId, "2b06a360");
  assert.equal(r.from, "2026-10-04T07:50:00.000Z");
  assert.equal(r.to, "2026-10-04T08:20:00.000Z");
  assert.equal(r.kql, "log.level:ERROR");
  assert.equal(r.filters.length, 2);
});

test("relative ranges resolve against the anchor", () => {
  const anchor = new Date("2026-10-04T08:00:00Z");
  assert.equal(absTime("now-15m", anchor).toISOString(), "2026-10-04T07:45:00.000Z");
  assert.equal(absTime("now", anchor).toISOString(), anchor.toISOString());
  assert.equal(absTime("2026-10-04T08:00:00.449509Z", anchor).toISOString(), "2026-10-04T08:00:00.449Z");
  const r = parseDiscover("https://kibana.prod.services.auto1.team/app/discover#/?_g=(time:(from:now-30m,to:now))", "2026-10-04T08:00:00Z");
  assert.equal(r.from, "2026-10-04T07:30:00.000Z");
});

test("unslack strips the <url|label> wrapper", () => {
  assert.equal(unslack("<https://x.y/z?a=1&amp;b=2|label>"), "https://x.y/z?a=1&b=2");
});

test("decodeLz returns null on garbage instead of throwing", () => {
  assert.equal(decodeLz("not-a-payload"), null);
});
