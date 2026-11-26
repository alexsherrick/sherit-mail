#!/usr/bin/env node
// GET /api/settings: Settings' seven parts in one round trip. The real Worker on real migrations and SQLite.
//  - each part is exactly what the route it stands for answers, with rows in every table it reads;
//  - a part whose route fails comes back as { __error } and the others are whole;
//  - signed in only;
//  - tracker status, its reads now made at once, answers as it did.
// Usage: node test/settingsapi.mjs (exit 1 on any failed check)
// CONTROL: SETTINGSAPI_SRC=<an index.js from before the change> node test/settingsapi.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) {
  const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(/;\s*$/m)) { try { if (stmt.trim()) sq.exec(stmt); } catch (_) {} }
}
const state = { broken: null };
const tick = () => new Promise((r) => setImmediate(r));
const run = (sql, p, kind) => { if (state.broken && state.broken.test(sql)) throw new Error("D1_ERROR: injected"); const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
const db = {
  prepare(sql) { const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a), all: async () => { await tick(); return run(sql, p, "all"); }, first: async () => { await tick(); return run(sql, p, "first"); }, run: async () => { await tick(); return run(sql, p, "run"); } }); return mk([]); },
  batch: async (xs) => { await tick(); return xs.map((x) => run(x._sql, x._p, "run")); },
};
const SRC = readFileSync(process.env.SETTINGSAPI_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_settingsapi_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));
globalThis.fetch = async (u) => new Response("{}", { status: 200 });
const env = { DB: db, STORE: { get: async () => null, put: async () => ({}), head: async () => null, delete: async () => {}, list: async () => ({ objects: [] }) }, FORWARD_TO: "me@gmail.com", DOMAINS: "hub.example", CLI_TOKEN: "t", SESSION_SECRET: "s", EMAIL: { send: async () => {} } };
const get = async (path, auth = true) => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { headers: auth ? { Authorization: "Bearer t" } : {} }), env, { waitUntil() {}, passThroughOnException() {} }); return { status: r.status, body: await r.json().catch(() => null) }; };

// rows in every table the seven parts read
const now = new Date().toISOString();
const ins = (sql, ...a) => { try { sq.prepare(sql).run(...a); } catch (e) { console.log("note: seed skipped: " + e.message.slice(0, 80)); } };
ins("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, ua, created_at) VALUES ('sub-1', 'https://push.example/1', 'k', 'a', 'Test Browser', ?)", now);
ins("INSERT INTO quiet_rules (id, sender, subject, created_at) VALUES ('q1', 'venmo@venmo.example', 'security code', ?)", now);
ins("INSERT INTO trash_rules (id, scope, name, subject, created_at) VALUES ('t1', '*', 'webmail', '', ?)", now);
ins("INSERT INTO address_locks (address, state, source, created_at) VALUES ('bank@hub.example', 'active', 'app', ?)", now);
ins("INSERT INTO mention_rules (id, pattern, scope, words, created_at) VALUES ('m1', '*@lakeside.example', '*', '[\"SXSW\"]', ?)", now);
ins("INSERT INTO trk_rules (pattern, kind, state, created_at, changed_at) VALUES ('px.tracker.example/open', 'learned', 'on', ?, ?)", now, now);
ins("INSERT INTO unsubscribes (id, sender, account, thread_id, status, created_at) VALUES ('u1', 'news@list.example', 'hub', 'th-1', 'done', ?)", now);

const SEVEN = { push: "/api/push/subscriptions", quiet: "/api/quiet-rules", trash: "/api/trash-rules", locks: "/api/locks", mention: "/api/mention-rules", trackers: "/api/trackers/status", unsubs: "/api/unsubscribes" };
const one = await get("/api/settings");
check(one.status === 200 && one.body && Object.keys(SEVEN).every((k) => k in one.body), `GET /api/settings answers the seven parts (${one.status}, ${one.body ? Object.keys(one.body).join(" ") : "no body"})`);
for (const [k, p] of Object.entries(SEVEN)) {
  const alone = await get(p);
  const same = JSON.stringify(one.body?.[k]) === JSON.stringify(alone.body);
  const rows = JSON.stringify(alone.body || {}).length;
  check(alone.status === 200 && same, `${k}: exactly what ${p} answers (${rows} characters${same ? "" : `; settings had ${String(JSON.stringify(one.body?.[k])).slice(0, 80)}`})`);
}
check(one.body && one.body.quiet?.rules?.length === 1 && one.body.trash?.rules?.length === 1 && one.body.mention?.rules?.length === 1 && one.body.trackers?.rules?.length === 1 && one.body.locks?.locks?.length === 1 && one.body.unsubs?.unsubscribes?.length === 1 && one.body.push?.subscriptions?.length === 1, "and the rows put in are there, one in each part");
state.broken = /FROM trash_rules/;
const part = await get("/api/settings"); state.broken = null;
check(part.status === 200 && part.body?.trash?.__error && part.body?.quiet?.rules?.length === 1 && part.body?.trackers?.rules?.length === 1, `a part whose route fails comes back as { __error }, the others whole (${JSON.stringify(part.body?.trash)})`);
const no = await get("/api/settings", false);
check(no.status === 401, `signed in only (${no.status})`);
console.log(fails.length ? `\n${fails.length} failed` : "\nall settings-api checks passed");
process.exit(fails.length ? 1 : 0);
