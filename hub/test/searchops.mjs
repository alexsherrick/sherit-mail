#!/usr/bin/env node
// EXECUTION test: Gmail's search operators in the hub's own search. Search must take Gmail's
// in:trash, in:archive and the like, or search everything. The real Worker's GET /api/threads over the real
// migrations in SQLite, asked as the device asks (box=all): in:trash lists trashed mail and nothing else, in:anywhere / in:all lists every
// folder, in:archive / in:done the archived, -in:inbox, in:sent, is:unread / is:starred / is:pinned, has:attachment (a file, not a picture
// the body shows), after:/before: (epoch seconds, as the device sends them, and a calendar date), and operators alone list the folder.
// Without an in: the search is as before: Trash left out. Then the device's parser (client/store.js parseSearch) and the hub's
// (searchQuery) read a table of queries the same way, and serverQuery turns Sherit's spellings into Gmail's.
// CONTROL: SEARCHOPS_SRC=<the Worker before the change> fails the in:, is:, has: and date checks (it read them as words).
// Usage: node test/searchops.mjs
process.env.TZ = "UTC";   // the device's parser reads a calendar date as local midnight, the Worker's as UTC: one clock for the parity table
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import vm from "node:vm";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq) => { const run = (sql, p, kind) => { const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => Promise.all(xs.map((x) => x.run())) }; };
const SRC = readFileSync(process.env.SEARCHOPS_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_searchops_worker.mjs`; writeFileSync(tmp, SRC); const mod = await import(tmp).finally(() => unlinkSync(tmp));

const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))); };
const exp = Date.now() + 86400000; const COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;
const sq = buildDb(); const env = { DB: d1(sq), SESSION_SECRET: SECRET, DOMAINS: "yourdomain.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };

// Seven conversations about a rocket, one per folder or flag, and one about something else.
const seed = (id, state, { subject = "Rocket report", body = "the launch went well", at, unread = 0, starred = 0, out = false, file = false, inlinePic = false, older = null } = {}) => {
  sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread, starred) VALUES (?, ?, 'x', ?, ?, ?, ?, ?)").run(id, subject.toLowerCase(), at, older ? 2 : 1, state, unread, starred);
  const msg = (mid, dir, when, html) => sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, subject, body_text, body_html, message_id, status, ingest_source, created_at) VALUES (?, ?, ?, 'sam@yourdomain.example', ?, 'Mission Control', ?, ?, ?, ?, 'stored', 'mailhub', ?)")
    .run(mid, id, dir, dir === "out" ? "sam@yourdomain.example" : "mc@space.example", subject, body, html, `<${mid}@x.example>`, when);
  if (older) msg("o" + id, "in", older, null);
  msg("m" + id, out ? "out" : "in", at, inlinePic ? '<p><img src="cid:pic1@x"></p>' : null);
  if (file || inlinePic) sq.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id) VALUES (?, ?, ?, ?, 10, ?, ?)").run("a" + id, "m" + id, file ? "report.pdf" : "pic.png", file ? "application/pdf" : "image/png", "att/" + id, file ? null : "<pic1@x>");
};
const DAY = 86400000, NOW = Date.UTC(2026, 10, 8, 12), iso = (ms) => new Date(ms).toISOString();
const IN = "11111111", AR = "22222222", TR = "33333333", SN = "44444444", SE = "55555555", PI = "66666666", OT = "77777777", OLD = "88888888";
seed(IN + "-0000-0000-0000-000000000001", "inbox", { at: iso(NOW - 1 * DAY), unread: 1 });
seed(AR + "-0000-0000-0000-000000000002", "archived", { at: iso(NOW - 10 * DAY), file: true });
seed(TR + "-0000-0000-0000-000000000003", "trash", { at: iso(NOW - 5 * DAY) });
seed(SN + "-0000-0000-0000-000000000004", "snoozed", { at: iso(NOW - 20 * DAY) });
seed(SE + "-0000-0000-0000-000000000005", "archived", { at: iso(NOW - 2 * DAY), out: true, starred: 1 });
seed(PI + "-0000-0000-0000-000000000006", "inbox", { at: iso(NOW - 3 * DAY), inlinePic: true });
seed(OT + "-0000-0000-0000-000000000007", "trash", { subject: "Dinner plans", body: "pizza at eight", at: iso(NOW - 4 * DAY) });
seed(OLD + "-0000-0000-0000-000000000008", "inbox", { at: iso(NOW - 1 * DAY), older: iso(NOW - 40 * DAY) });   // a conversation spanning a month
async function ids(q, box = "all") {
  const r = await mod.default.fetch(new Request(`https://hub.example/api/threads?limit=200&box=${box}&q=` + encodeURIComponent(q), { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} });
  const j = await r.json().catch(() => null); return r.status === 200 && j && j.threads ? j.threads.map((t) => t.id.slice(0, 8)).sort() : ["status " + r.status];
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());
const ep = (ms) => Math.floor(ms / 1000);
let r;
r = await ids("rocket"); check(same(r, [IN, AR, SN, SE, PI, OLD]), `no in: — every folder but Trash, as before (${r})`);
r = await ids("rocket in:trash"); check(same(r, [TR]), `in:trash lists the trashed conversation and nothing else (${r})`);
r = await ids("in:trash"); check(same(r, [TR, OT]), `in:trash alone lists all of Trash (${r})`);
r = await ids("rocket in:anywhere"); check(same(r, [IN, AR, TR, SN, SE, PI, OLD]), `in:anywhere lists every folder, Trash too (${r})`);
r = await ids("rocket in:all"); check(same(r, [IN, AR, TR, SN, SE, PI, OLD]), `in:all is in:anywhere (${r})`);
r = await ids("rocket in:archive"); check(same(r, [AR, SE]), `in:archive lists the archived (${r})`);
r = await ids("rocket in:done"); check(same(r, [AR, SE]), `in:done, Sherit's word for it, is in:archive (${r})`);
r = await ids("rocket -in:inbox"); check(same(r, [AR, SN, SE]), `-in:inbox: the rest, still not Trash (${r})`);
r = await ids("rocket in:snoozed"); check(same(r, [SN]), `in:snoozed (${r})`);
r = await ids("rocket in:sent"); check(same(r, [SE]), `in:sent: a conversation holding a message sent (${r})`);
r = await ids("rocket in:spam"); check(same(r, []), `in:spam: hub mail has no Spam folder (${r})`);
r = await ids("rocket in:trash", "inbox"); check(same(r, [TR]), `the query's in: overrides the box asked for (${r})`);
r = await ids("rocket", "inbox"); check(same(r, [IN, PI, OLD]), `with no in:, the box still applies (${r})`);
r = await ids("rocket is:unread"); check(same(r, [IN]), `is:unread (${r})`);
r = await ids("rocket -is:read"); check(same(r, [IN]), `-is:read is is:unread (${r})`);
r = await ids("rocket is:starred"); check(same(r, [SE]), `is:starred (${r})`);
r = await ids("rocket is:pinned"); check(same(r, [SE]), `is:pinned, Sherit's word for a star (${r})`);
r = await ids("rocket has:attachment"); check(same(r, [AR]), `has:attachment: the PDF, not the picture the body shows (${r})`);
r = await ids("rocket -has:attachment"); check(same(r, [IN, SN, SE, PI, OLD]), `-has:attachment (${r})`);
r = await ids(`rocket after:${ep(NOW - 4 * DAY)}`); check(same(r, [IN, SE, PI, OLD]), `after: (epoch seconds, as the device sends it) (${r})`);
r = await ids(`rocket before:${ep(NOW - 4 * DAY)}`); check(same(r, [AR, SN, OLD]), `before: is any message before — the month-long conversation too (${r})`);
r = await ids("rocket after:2026/11/04 before:2026/11/07"); check(same(r, [SE, PI]), `a calendar date, midnight UTC; both ends on one message, as Gmail — not the month-long conversation (${r})`);
r = await ids("rocket in:trash after:2026/11/01"); check(same(r, [TR]), `operators combine (${r})`);
r = await ids("pizza in:anywhere"); check(same(r, [OT]), `a word in a trashed message's text, with in:anywhere (${r})`);
r = await ids("pizza"); check(same(r, []), `… and not without it (${r})`);
r = await ids('subject:"rocket report" in:trash'); check(same(r, [TR]), `a quoted phrase with an operator (${r})`);
r = await ids("rocket in:lalala"); check(same(r, []), `an in: Gmail does not know stays a word, as before (${r})`);

// The two parsers, one table. The device's runs in a VM over client/store.js as the page loads it.
const ctx = vm.createContext({ console, Date, Math, Number, String, JSON, Object, Array, Map, Set, RegExp, setTimeout, clearTimeout });
vm.runInContext(readFileSync(HUB + "src/client/store.js", "utf8") + "\n;globalThis.__p = typeof parseSearch === 'function' ? { parseSearch, serverQuery } : null;", ctx);
const dev = ctx.__p, hubp = mod.searchQuery;
check(!!dev && typeof hubp === "function", "both parsers exist (store.js parseSearch, index.js searchQuery)");
if (dev && hubp) {
  const T = ["", "rocket", "rocket in:trash", "in:Trash", "-in:inbox foo", "in:done", "in:archived", "in:all", "in:anywhere", "in:bin", "in:junk", "in:sent in:inbox",
    "is:unread", "is:read", "-is:unread", "is:pinned", "-is:starred", "has:attachment", "has:attachments", "-has:attachment", "in:lalala", "is:important", "has:drive",
    "after:2026/11/01", "after:2026-11-01", "after:11/01/2026", "before:1794000371", "after:2026/13/01", "after:2026/02/30", "older_than:2d", "newer_than:3m", "newer_than:1y",
    "older_than:2026/01/01", "after:2d", "-after:2026/11/01", "-older_than:1d", "newer:2026/11/01 older:2026/11/05", "after:2026/11/01 after:2026/11/03 before:2026/11/09 before:2026/11/07",
    'subject:"in:trash" from:bob', '"hello there" in:archive -word', "account:x in:trash", "IN:TRASH IS:UNREAD", "in:", "-", "in:trash  extra   spaces"];
  const norm = (s) => JSON.stringify({ ...s, in: [...s.in], notIn: [...s.notIn], want: [...s.want] });
  const diff = T.filter((q) => norm(dev.parseSearch(q, NOW)) !== norm(hubp(q, NOW)));
  check(!diff.length, `the device and the hub read ${T.length} queries the same way${diff.length ? ": " + diff.join(" | ") : ""}`);
  const P = (q) => dev.parseSearch(q, NOW);
  let s = P("rocket in:trash"); check(s.text === "rocket" && s.in.join() === "trash" && s.ops, `"rocket in:trash": word rocket, folder trash (${norm(s)})`);
  s = P("in:done is:pinned has:attachments"); check(s.text === "" && s.in.join() === "archived" && s.want.join() === "starred,att", `Sherit's words read as Gmail's (${norm(s)})`);
  s = P("-in:inbox -is:unread -has:attachment"); check(s.notIn.join() === "inbox" && s.want.join() === "read,noatt", `negations (${norm(s)})`);
  s = P("in:lalala is:important has:drive"); check(s.text === "in:lalala is:important has:drive" && !s.ops, `operators Sherit does not read stay words (${norm(s)})`);
  s = P('subject:"in:trash"'); check(s.text === 'subject:"in:trash"' && !s.in.length, `an operator inside quotes is a phrase (${norm(s)})`);
  s = P("after:2026/11/01"); check(s.after === Date.UTC(2026, 10, 1), `after:2026/11/01 is its midnight (${s.after})`);
  s = P("after:11/01/2026"); check(s.after === Date.UTC(2026, 10, 1), `Gmail's MM/DD/YYYY (${s.after})`);
  s = P("before:1794000371"); check(s.before === 1794000371000, `epoch seconds (${s.before})`);
  s = P("after:2026/02/30"); check(s.after === null && s.text === "after:2026/02/30", `a date that does not exist stays a word (${norm(s)})`);
  s = P("older_than:2d"); check(s.before === NOW - 2 * DAY, `older_than:2d (${s.before})`);
  s = P("newer_than:1y"); check(s.after === Date.UTC(2025, 10, 8, 12), `newer_than:1y (${s.after})`);
  s = P("-after:2026/11/01"); check(s.before === Date.UTC(2026, 10, 1) && s.after === null, `-after: is before: (${norm(s)})`);
  s = P("after:2026/11/01 after:2026/11/03 before:2026/11/09 before:2026/11/07"); check(s.after === Date.UTC(2026, 10, 3) && s.before === Date.UTC(2026, 10, 7), `the narrowest of each end (${norm(s)})`);
  const g = dev.serverQuery("rocket in:done is:pinned has:attachments newer_than:2d -in:inbox", NOW);
  check(g === `rocket in:archive -in:inbox is:starred has:attachment after:${ep(NOW - 2 * DAY)}`, `serverQuery: Gmail's spelling, dates as epoch seconds (${g})`);
  check(dev.serverQuery("rocket  report", NOW) === "rocket  report", "serverQuery leaves a query with no operator as typed");
  check(dev.serverQuery("in:all", NOW) === "in:anywhere" && dev.serverQuery("in:bin -is:pinned", NOW) === "in:trash -is:starred", `in:all → in:anywhere, in:bin → in:trash, -is:pinned → -is:starred`);
  const back = hubp(dev.serverQuery("rocket in:done is:pinned has:attachments after:2026/11/01", NOW), NOW);
  check(back.text === "rocket" && back.in.join() === "archived" && back.want.join() === "starred,att" && back.after === Date.UTC(2026, 10, 1), `the hub reads what serverQuery sends (${norm(back)})`);
}
console.log(fails.length ? `${fails.length} failed` : "all searchops checks passed"); process.exit(fails.length ? 1 : 0);
