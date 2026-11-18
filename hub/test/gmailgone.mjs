#!/usr/bin/env node
// A Gmail message that is gone before the poll reads it is not notified. The real Worker's Gmail poll and mirror, real
// migrations on real SQLite, and a fake Gmail that keeps a mailbox and its history.
//  2026-11-18: Gmail's package tracking put a short-lived message into an old shop shipping email (unread, important, in the inbox)
//  and removed it seconds later, with no deletion in the history. The poll could not read it and pushed a notification anyway: the
//  account as its title, "(no subject)", and a link to no conversation. Five such pushes since 2026-10-19.
//  - gone (404) when read: no push, a gmail_poll_gone event naming the message and its conversation;
//  - a real message beside it: pushed as before, with its sender, subject and conversation;
//  - read failing once and then working: pushed with its sender and subject;
//  - read failing every time: pushed as before, now with its conversation from the history so the tap opens it.
// Usage: node test/gmailgone.mjs (exit 1 on any failed check)
// CONTROL: GMAILGONE_SRC=<an index.js from before the fix> node test/gmailgone.mjs must fail.
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
const tick = () => new Promise((r) => setImmediate(r));
const db = {
  prepare(sql) { const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a), all: async () => { await tick(); return { results: sq.prepare(sql).all(...p) }; }, first: async () => { await tick(); return sq.prepare(sql).get(...p) ?? null; }, run: async () => { await tick(); return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; } }); return mk([]); },
  batch: async (xs) => { await tick(); sq.exec("SAVEPOINT b"); try { const out = xs.map((x) => ({ meta: { changes: Number(sq.prepare(x._sql).run(...x._p).changes) } })); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } },
};
const SRC = readFileSync(process.env.GMAILGONE_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_gmailgone_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

const NOW = Date.now(); let seq = 0; const gid = () => Math.floor(NOW).toString(16) + (++seq).toString(16).padStart(5, "0");
const E = "sam.owner@gmail.com";
class Gmail {   // one mailbox and its history; failMeta: id -> how many metadata reads answer 500 before one works (Infinity: never)
  constructor() { this.msgs = new Map(); this.hist = []; this.hid = 5000; this.failMeta = new Map(); }
  rec(r) { this.hid += 3; this.hist.push({ id: String(this.hid), ...r }); return this.hid; }
  put(labels, { from, subject, thread = null }) {
    const id = gid(), threadId = thread || "t" + id;
    this.msgs.set(id, { id, threadId, labelIds: labels, internalDate: String(NOW), snippet: "", subject, from });
    this.msgs.get(id).hid = this.rec({ messagesAdded: [{ message: { id, threadId, labelIds: labels } }] });
    return { id, threadId };
  }
  resource(m) { return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.snippet, historyId: String(m.hid), sizeEstimate: 100, payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "To", value: E }] } }; }
  async fetch(url, o = {}) {
    const u = String(url), json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    if (u === "https://gmail.googleapis.com/batch/gmail/v1") {   // the mirror's batched gets: a message failing its reads fails here too
      const ids = [...String(o.body).matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)\?/g)].map((x) => x[1]), B = "batch_resp_x";
      const body = ids.map((id, k) => { const m = this.msgs.get(id), bad = this.failMeta.has(id); return `--${B}\r\nContent-Type: application/http\r\nContent-ID: <response-i${k}>\r\n\r\n` + (m && !bad ? `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.resource(m))}\r\n` : `HTTP/1.1 ${bad ? "500 Internal Server Error" : "404 Not Found"}\r\nContent-Type: application/json\r\n\r\n{"error":{"code":${bad ? 500 : 404}}}\r\n`); }).join("") + `--${B}--\r\n`;
      return new Response(body, { status: 200, headers: { "content-type": `multipart/mixed; boundary=${B}` } });
    }
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/";
    if (!u.startsWith(base)) return json({ error: "unmocked " + u }, 404);
    const path = u.slice(base.length), q = new URL(u).searchParams;
    if (path.startsWith("profile")) return json({ historyId: String(this.hid), emailAddress: E });
    if (path.startsWith("history?")) {
      let recs = this.hist.filter((h) => Number(h.id) > Number(q.get("startHistoryId")));
      if (q.get("labelId") === "INBOX") recs = recs.filter((h) => (h.messagesAdded || []).some((x) => (x.message.labelIds || []).includes("INBOX")));
      return json({ history: recs, historyId: String(this.hid) });
    }
    if (path.startsWith("messages?")) return json({ messages: [...this.msgs.values()].map((m) => ({ id: m.id, threadId: m.threadId })) });
    let x;
    if ((x = path.match(/^messages\/([^/?]+)\?format=metadata/))) {
      const left = this.failMeta.get(x[1]); if (left) { this.failMeta.set(x[1], left - 1); if (left - 1 <= 0) this.failMeta.delete(x[1]); return json({ error: { code: 500, message: "backend error" } }, 500); }
      const m = this.msgs.get(x[1]); return m ? json(this.resource(m)) : json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
    }
    if ((x = path.match(/^messages\/([^/?]+)\?format=minimal$/))) { const m = this.msgs.get(x[1]); return m ? json({ id: m.id, labelIds: m.labelIds }) : json({ error: { code: 404 } }, 404); }
    if ((x = path.match(/^threads\/([^/?]+)\?format=minimal$/))) return json({ id: x[1], messages: [...this.msgs.values()].filter((m) => m.threadId === x[1]).map((m) => ({ id: m.id, labelIds: m.labelIds })) });
    return json({ error: "unmocked " + u }, 404);
  }
}
const realFetch = globalThis.fetch, g = new Gmail();
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const env = { DB: db, GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", FORWARD_TO: "me@gmail.com", DOMAINS: "hub.example", CLI_TOKEN: "t", SESSION_SECRET: "s", EMAIL: { send: async () => {} } };
const sealed = await mod.sealToken(env, "refresh-token", E);
sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, label) VALUES (?, ?, ?, 's', 'active', '2026-10-07', 'Mine')").run(E, sealed.enc, sealed.iv);
globalThis.fetch = (u, o) => g.fetch(u, o);
try {
  const old = g.put(["CATEGORY_UPDATES", "INBOX"], { from: '"Example Shop" <store+1@shop.example>', subject: "A shipment from order #1001 is on the way" });
  for (let i = 0; i < 20 && sq.prepare("SELECT mirror_state FROM gmail_accounts WHERE email = ?").get(E)?.mirror_state !== "ready"; i++) await mod.gmailMirrorOnce(env, E);
  const poll = async () => { await mod.gmailMirrorOnce(env, E).catch(() => {}); return mod.gmailPollAccount(env, { email: E }, async () => sq.prepare("SELECT pattern, action, scope, category FROM sender_rules").all(), "all"); };
  await poll();   // takes the poll's first cursor
  const feed = () => sq.prepare("SELECT payload FROM notify_feed ORDER BY seq").all().map((r) => JSON.parse(r.payload));
  const ev = (kind) => sq.prepare("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => r.detail);
  // 1. the bump: a message into the old shipping email, gone before the poll reads it
  const n0 = feed().length;
  const bump = g.put(["UNREAD", "IMPORTANT", "INBOX"], { from: "x", subject: "x", thread: old.threadId }); g.msgs.delete(bump.id);
  await poll();
  check(feed().length === n0, `a message gone before it is read is not notified (${feed().length - n0} pushes: ${JSON.stringify(feed().slice(n0))})`);
  const gone = ev("gmail_poll_gone");
  check(gone.length === 1 && gone[0].includes(bump.id) && gone[0].includes(old.threadId) && gone[0].includes("INBOX"), `and it is logged with its id, conversation and labels (${JSON.stringify(gone)})`);
  // 2. a real message: pushed as before
  const real = g.put(["UNREAD", "INBOX"], { from: '"A Friend" <friend@else.example>', subject: "Dinner Friday?" });
  await poll(); const p2 = feed().at(-1);
  check(feed().length === n0 + 1 && p2.title === "A Friend" && /Dinner Friday\?/.test(p2.body) && p2.thread === real.threadId, `a real message is notified with its sender, subject and conversation (${JSON.stringify(p2)})`);
  // 3. a read that fails once, then works
  const flaky = g.put(["UNREAD", "INBOX"], { from: '"Another Friend" <other@else.example>', subject: "Photos" }); g.failMeta.set(flaky.id, 1);
  await poll(); const p3 = feed().at(-1);
  check(feed().length === n0 + 2 && p3.title === "Another Friend" && /Photos/.test(p3.body), `a read that fails once is tried again and notified with its sender and subject (${JSON.stringify(p3)})`);
  // 4. a read that keeps failing: notified as before, with the conversation from the history
  const stuck = g.put(["UNREAD", "INBOX"], { from: '"Third" <third@else.example>', subject: "Hello" }); g.failMeta.set(stuck.id, Infinity);
  await poll(); const p4 = feed().at(-1);
  check(feed().length === n0 + 3 && p4.thread === stuck.threadId && p4.url.includes(encodeURIComponent(stuck.threadId)), `a message that cannot be read is still notified, and its tap opens the conversation (${JSON.stringify(p4)})`);
} finally { globalThis.fetch = realFetch; }
console.log(fails.length ? `\n${fails.length} failed` : "\nall gone-message checks passed");
process.exit(fails.length ? 1 : 0);
