#!/usr/bin/env node
// EXECUTION test: a quoted phrase in the search box is exact in the hub's own search. As in Gmail, a quoted
// phrase matches those words together, in that order. The real Worker's GET /api/threads
// over the real migrations in SQLite: "hello there" lists only the thread whose subject holds those words together; hello there without
// quotes lists every thread holding both words; a sender's NAME is searched; a typed % is literal; a word in a body's text is found.
// CONTROL: PHRASE_SRC=<the Worker before the change> fails the phrase, the two-word, the name and the % checks.
// Usage: node test/phrase.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq) => { const run = (sql, p, kind) => { const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => Promise.all(xs.map((x) => x.run())) }; };
const SRC = readFileSync(process.env.PHRASE_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_phrase_worker.mjs`; writeFileSync(tmp, SRC); const mod = await import(tmp).finally(() => unlinkSync(tmp));

const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))); };
const exp = Date.now() + 86400000; const COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;
const sq = buildDb(); const env = { DB: d1(sq), SESSION_SECRET: SECRET, DOMAINS: "yourdomain.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
// four conversations: A "Hello there" from Bob; B "There, hello again" from Carol; C "Invoice 100% paid"; D "Invoice 1000 paid" whose body says budget
const seed = (id, from_name, from_addr, subject, body, at) => {
  sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state) VALUES (?, ?, 'x', ?, 1, 'inbox')").run(id, subject.toLowerCase(), at);
  sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, subject, body_text, message_id, status, ingest_source, created_at) VALUES (?, ?, 'in', 'sam@yourdomain.example', ?, ?, ?, ?, ?, 'stored', 'mailhub', ?)")
    .run("m" + id, id, from_addr, from_name, subject, body, `<${id}@x.example>`, at);
};
seed("aaaaaaaa-0000-0000-0000-000000000001", "Bob", "b@x.example", "Hello there", "a short note", "2026-10-27T10:00:00Z");
seed("bbbbbbbb-0000-0000-0000-000000000002", "Carol", "c@x.example", "There, hello again", "nothing much", "2026-10-27T09:00:00Z");
seed("cccccccc-0000-0000-0000-000000000003", "Shop", "s@x.example", "Invoice 100% paid", "thanks", "2026-10-27T08:00:00Z");
seed("dddddddd-0000-0000-0000-000000000004", "Shop", "s@x.example", "Invoice 1000 paid", "we are over budget this month", "2026-10-27T07:00:00Z");
const A = "aaaaaaaa", B = "bbbbbbbb", C = "cccccccc", D = "dddddddd";
async function ids(q) {
  const r = await mod.default.fetch(new Request("https://hub.example/api/threads?limit=200&box=inbox&q=" + encodeURIComponent(q), { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} });
  const j = await r.json().catch(() => null); return r.status === 200 && j && j.threads ? j.threads.map((t) => t.id.slice(0, 8)).sort() : ["status " + r.status];
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());
let r;
r = await ids('"hello there"'); check(same(r, [A]), `"hello there" in quotes lists only the thread with those words together (${r})`);
r = await ids("hello there"); check(same(r, [A, B]), `hello there without quotes lists every thread holding both words (${r})`);
r = await ids('"there hello"'); check(same(r, []), `"there hello" lists nothing: the order counts (${r})`);
r = await ids("bob"); check(same(r, [A]), `a sender's name is searched (${r})`);
r = await ids('"hello there" bob'); check(same(r, [A]), `a phrase and a word are both required (${r})`);
r = await ids('"hello there" carol'); check(same(r, []), `… so the phrase with the other sender's name lists nothing (${r})`);
r = await ids("100%"); check(same(r, [C]), `a typed % is the character, not a wildcard (${r})`);
r = await ids("budget"); check(same(r, [D]), `a word in a message's text is found (${r})`);
r = await ids("invoice -paid"); check(same(r, [C, D]), `an exclusion is the device index's: the hub answers with the word alone (${r})`);
r = await ids("hello"); check(same(r, [A, B]), `a bare word still finds what it found before (${r})`);
console.log(fails.length ? `${fails.length} failed` : "all phrase checks passed"); process.exit(fails.length ? 1 : 0);
