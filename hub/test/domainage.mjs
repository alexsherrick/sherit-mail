#!/usr/bin/env node
// GET /api/domain-age: asked only after a brand alarm, it answers from D1 for 30 days and from RDAP otherwise, refuses
// anything that is not a public domain name, and never makes more than 60 RDAP requests in 15 minutes. Real Worker, real migrations,
// rdap.org stubbed at globalThis.fetch. Usage: node test/domainage.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
const HUB = new URL("../", import.meta.url).pathname; const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; const o = (buf.match(/\bBEGIN\b/gi) || []).length, c = (buf.match(/\bEND\b/gi) || []).length; if (o === c) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).map((l) => l.replace(/\s--\s.*$/, "")).join("\n"))) { try { sq.exec(st); } catch (_) {} }
const d1 = { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) ?? null, run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }) }); return mk([]); }, batch: async (xs) => Promise.all(xs.map((x) => x.run())) };
const asked = [];
let directoryFetches = 0, registryDown = false;
globalThis.fetch = async (input) => { const u = new URL(typeof input === "string" ? input : input.url);
  if (u.href === "https://data.iana.org/rdap/dns.json") { directoryFetches++; return new Response(JSON.stringify({ services: [[["info", "biz"], ["http://insecure.example/", "https://rdap.identitydigital.services/rdap/"]], [["com"], ["https://rdap.verisign.com/com/v1/"]], [["uk"], ["https://rdap.nominet.uk/uk/"]], [["example"], ["https://rdap.example-registry.test/"]]] })); }
  if (u.hostname === "rdap.org") throw new Error("rdap.org must not be used: it answers Cloudflare with a 403 page");
  asked.push(u.href);
  if (registryDown) return new Response("busy", { status: 503 });
  if (u.href === "https://rdap.identitydigital.services/rdap/domain/jhgbmk.info") return new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2026-09-07T12:48:50.643Z" }] }));
  return new Response("{}", { status: 404 }); };
const SRC = readFileSync(HUB + "src/index.js", "utf8").replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};").replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };').replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";').replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_domainage_worker.mjs`; writeFileSync(tmp, SRC); let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }
const env = { DB: d1, CLI_TOKEN: "cli" };
const get = async (d) => { const r = await mod.default.fetch(new Request("https://hub.example/api/domain-age?d=" + encodeURIComponent(d), { headers: { Authorization: "Bearer cli" } }), env, { waitUntil: () => {} }); return { status: r.status, body: await r.json() }; };
let r = await get("jhgbmk.info");
check(r.status === 200 && r.body.registered === "2026-09-07T12:48:50.643Z" && asked.length === 1 && asked[0].startsWith("https://rdap.identitydigital.services/"), `the phish's domain: asked of .info's own registry (found in IANA's directory, https only), registered 2026-09-07 (${JSON.stringify(r.body)})`);
r = await get("www.JHGBMK.info");
check(r.body.cached === true && asked.length === 1, "asked again (any case, with www.): answered from D1, no second request");
r = await get("links.sub.jhgbmk.info");
check(r.body.domain === "jhgbmk.info" && asked.length === 1, "a subdomain is looked up as its registered domain");
r = await get("shop.example.co.uk"); check(r.body.domain === "example.co.uk", `a two-label suffix keeps three labels (${r.body.domain})`);
for (const bad of ["localhost", "10.0.0.1", "printer.lan", "", "a"]) { const n = asked.length; r = await get(bad); check(r.status === 400 && asked.length === n, `refused without a lookup: ${JSON.stringify(bad)}`); }
sq.exec("DELETE FROM events WHERE kind = 'rdap'"); const n0 = asked.length; let limited = 0;
for (let i = 0; i < 62; i++) { r = await get(`d${i}.example`); if (r.body.limited) limited++; }   //.example's registry is in the stub directory
check(asked.length - n0 === 60 && limited === 2, `at most 60 RDAP requests in 15 minutes (${asked.length - n0} made, ${limited} refused)`);
check(directoryFetches === 1, `IANA's directory is fetched once, not per lookup (${directoryFetches})`);
{ // a failed lookup is remembered for a day, not a month
  sq.exec("DELETE FROM events WHERE kind = 'rdap'");   // the rate-limit check above spent this window's 60 lookups
  registryDown = true; const n = asked.length; r = await get("fresh-phish.info"); check(r.body.registered === null && asked.length === n + 1, "a registry that fails answers null");
  r = await get("fresh-phish.info"); check(r.body.cached === true && asked.length === n + 1, "and is not asked again within the day");
  sq.prepare("UPDATE domain_ages SET checked_at = ? WHERE domain = 'fresh-phish.info'").run(new Date(Date.now() - 2 * 86400e3).toISOString());
  registryDown = false; r = await get("fresh-phish.info"); check(asked.length === n + 2, "but is asked again after a day, unlike a found date (30 days)");
}
const noauth = await mod.default.fetch(new Request("https://hub.example/api/domain-age?d=jhgbmk.info"), env, { waitUntil: () => {} });
check(noauth.status === 401, "only the signed-in app or the CLI may ask");
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall domain-age checks passed");
