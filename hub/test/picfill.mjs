#!/usr/bin/env node
// The picture fill: mail the Gmail mirror brings in without an arrival gets its pictures queued, as an arrival would.
// A newly connected account's 23 mails since the picture queue began showed no pictures (117 of them): the first fill copies
// headers only, the poll's arrival prefetch never saw them, and a picture of the window is never fetched at an open ("not-kept").
// The real Worker's mirror, picture queue, drain and /api/img on real migrations and SQLite, a fake Gmail and a fake picture host.
//  - an account's first fill notes the mail of the picture window, newest first; not older mail, not Spam;
//  - once the mirror is ready, the next run reads those mails and queues their pictures, due now, for their sender; not the tracker
//  pixel, and nothing for the older mail or Spam; a gmail_pic_fill event;
//  - the cron's drain keeps them, and the open the app makes (with the mail's arrival) is answered from R2, asking the sender nothing;
//  - with under half of the day's picture allowance left the fill waits, and goes on once there is room;
//  - a rebuild after Gmail expired the cursor notes only mail the hub did not have;
// Usage: node test/picfill.mjs (exit 1 on any failed check)
// CONTROL: PICFILL_SRC=<an index.js from before the fill> node test/picfill.mjs must fail.
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
const SRC = readFileSync(process.env.PICFILL_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_picfill_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

const DAY = 864e5, NOW = Date.now(), QUEUE_BEGAN = Date.parse("2026-11-08T00:00:00Z");
const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const png = (n) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 30]); return b; };
const pics = (k) => [`https://img.shop.example/${k}/hero.png`, `https://cdn.shop.example/${k}/logo?w=120&s=2`];
const page = (k) => `<p>Hello</p><img src="${pics(k)[0]}" width="300" height="200"><img src=${pics(k)[1].replace("&", "&amp;")} width=120><img src="https://u2.ct.sendgrid.net/wf/open?upn=${k}" width="1" height="1">`;
class Gmail {
  constructor(email) { this.email = email; this.msgs = new Map(); this.hist = []; this.hid = 9000; this.floor = 0; this.seq = 0; this.fullReads = 0; }
  rec(r) { this.hid += 3; this.hist.push({ id: String(this.hid), ...r }); return this.hid; }
  put(labels, at, { from = '"Example Shop" <news@shop.example>', k }) {
    const id = Math.floor(at).toString(16) + (++this.seq).toString(16).padStart(5, "0"), threadId = "t" + id;
    this.msgs.set(id, { id, threadId, labelIds: labels, internalDate: String(Math.floor(at)), from, subject: "Offer " + k, k });
    this.msgs.get(id).hid = this.rec({ messagesAdded: [{ message: { id, threadId, labelIds: labels } }] });
    return id;
  }
  resource(m, full) {
    const headers = [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "To", value: this.email }];
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: "", historyId: String(m.hid), sizeEstimate: 100,
      payload: full ? { mimeType: "multipart/alternative", headers, parts: [{ mimeType: "text/plain", body: { data: b64u("Hello") } }, { mimeType: "text/html", body: { data: b64u(page(m.k)) } }] } : { mimeType: "text/plain", headers } };
  }
  handle(u, o, json) {
    if (u === "https://gmail.googleapis.com/batch/gmail/v1") {
      const ids = [...String(o.body).matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)\?/g)].map((x) => x[1]), B = "batch_resp_x";
      const body = ids.map((id, k) => { const m = this.msgs.get(id); return `--${B}\r\nContent-Type: application/http\r\nContent-ID: <response-i${k}>\r\n\r\n` + (m ? `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.resource(m, false))}\r\n` : `HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"code":404}}\r\n`); }).join("") + `--${B}--\r\n`;
      return new Response(body, { status: 200, headers: { "content-type": `multipart/mixed; boundary=${B}` } });
    }
    const path = u.slice("https://gmail.googleapis.com/gmail/v1/users/me/".length), q = new URL(u).searchParams;
    if (path.startsWith("profile")) return json({ historyId: String(this.hid), emailAddress: this.email });
    if (path.startsWith("history?")) {
      if (Number(q.get("startHistoryId")) < this.floor) return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
      return json({ history: this.hist.filter((h) => Number(h.id) > Number(q.get("startHistoryId"))), historyId: String(this.hid) });
    }
    if (path.startsWith("messages?")) return json({ messages: [...this.msgs.values()].map((m) => ({ id: m.id, threadId: m.threadId })) });
    let x;
    if ((x = path.match(/^messages\/([^/?]+)\?format=full$/))) { this.fullReads++; const m = this.msgs.get(decodeURIComponent(x[1])); return m ? json(this.resource(m, true)) : json({ error: { code: 404 } }, 404); }
    if ((x = path.match(/^messages\/([^/?]+)\?/))) { const m = this.msgs.get(x[1]); return m ? json(this.resource(m, false)) : json({ error: { code: 404 } }, 404); }
    return json({ error: "unmocked " + u }, 404);
  }
}
const boxes = new Map(); let current = null;   // the fake Gmail answers for the account whose token was minted last
const host = { asked: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, o = {}) => {
  const u = String(typeof input === "string" ? input : input.url), json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (u.startsWith("https://cloudflare-dns.com/")) return json({ Answer: [{ type: 1, data: "93.184.216.34" }] });
  if (u === "https://oauth2.googleapis.com/token") return json({ access_token: "at-" + current, expires_in: 3600 });
  if (u.startsWith("https://gmail.googleapis.com/")) {
    const auth = (o.headers && (o.headers.Authorization || o.headers.authorization)) || (input.headers && input.headers.get && input.headers.get("authorization")) || "";
    const who = String(auth).replace(/^Bearer at-/, ""); return boxes.get(who || current).handle(u, o, json);
  }
  if (/\.shop\.example$/.test(new URL(u).hostname)) { host.asked.push(u); return new Response(png(2000), { headers: { "content-type": "image/png", "content-length": "2000" } }); }
  return json({ error: "unmocked " + u }, 404);
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const r2 = new Map();
const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k) => (r2.has(k) ? { body: new Response(r2.get(k).buf).body, httpMetadata: { contentType: r2.get(k).ct }, customMetadata: {} } : null), put: async (k, buf, o) => { const b = buf instanceof ArrayBuffer ? buf : await new Response(buf).arrayBuffer(); r2.set(k, { buf: b, ct: o?.httpMetadata?.contentType }); }, delete: async (k) => { r2.delete(k); }, list: async () => ({ objects: [], truncated: false }) };
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const env = { DB: db, STORE, GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", GMAIL_MIRROR: "on", FORWARD_TO: "me@gmail.com", DOMAINS: "hub.example", CLI_TOKEN: "t", SESSION_SECRET: "s", EMAIL: { send: async () => {} } };
const connect = async (email) => { const s = await mod.sealToken(env, "refresh-token", email); sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at) VALUES (?, ?, ?, 's', 'active', ?)").run(email, s.enc, s.iv, new Date().toISOString()); boxes.set(email, new Gmail(email)); return boxes.get(email); };
const once = async (email) => { current = email; return mod.gmailMirrorOnce(env, email); };
const untilReady = async (email) => { for (let i = 0; i < 20 && sq.prepare("SELECT mirror_state FROM gmail_accounts WHERE email = ?").get(email)?.mirror_state !== "ready"; i++) await once(email); };
const progress = (email) => JSON.parse(sq.prepare("SELECT mirror_progress FROM gmail_accounts WHERE email = ?").get(email)?.mirror_progress || "{}");
const rows = () => sq.prepare("SELECT url, state, dom, next_at FROM img_queue").all();
const open = async (url, t) => { const n0 = host.asked.length; const res = await mod.default.fetch(new Request("https://hub.example/api/img?u=" + encodeURIComponent(url) + "&w=1600&t=" + t, { headers: { Authorization: "Bearer t" } }), env, { waitUntil: () => {}, passThroughOnException() {} }); await res.arrayBuffer().catch(() => {}); return { status: res.status, source: res.headers.get("x-img-source"), asked: host.asked.length - n0 }; };

try {
  // ---------- 1. a newly connected account ----------
  const A = "sam.owner@gmail.com", g = await connect(A);
  const recent = g.put(["CATEGORY_PROMOTIONS", "INBOX"], NOW - 2 * DAY, { k: "recent" });
  const newer = g.put(["CATEGORY_PROMOTIONS", "INBOX"], NOW - 1 * DAY, { k: "newer" });
  const spam = g.put(["SPAM"], NOW - 1 * DAY, { k: "spam", from: '"Prize" <win@spam.example>' });
  // before the queue began: in the mirror until 2027-02-02, never in the picture window
  const before = g.put(["CATEGORY_PROMOTIONS", "INBOX"], QUEUE_BEGAN - 3 * DAY, { k: "before" });
  await untilReady(A);
  const noted = (progress(A).pics || []).map((x) => x[0]);
  check(JSON.stringify(noted) === JSON.stringify([newer, recent]), `the first fill notes the window's mail, newest first, not Spam or older mail (${noted.length}: ${noted.map((id) => id === newer ? "newer" : id === recent ? "recent" : id === spam ? "spam" : id === before ? "before" : id)})`);
  await once(A);
  const q = rows(), urls = q.map((r) => r.url);
  const want = [...pics("recent"), ...pics("newer")];
  check(want.every((u) => urls.includes(u)), `the next run queues both mails' pictures, a bare src read whole (${want.filter((u) => urls.includes(u)).length} of 4)`);
  check(q.filter((r) => want.includes(r.url)).length === 4 && q.filter((r) => want.includes(r.url)).every((r) => r.state === "pending" && r.dom === "shop.example" && Date.parse(r.next_at) <= Date.now() + 1000), `due now, for their sender (${JSON.stringify(q.filter((r) => want.includes(r.url)).map((r) => [r.state, r.dom]))})`);
  check(!urls.some((u) => /sendgrid|\/spam\/|\/before\//.test(u)), `not the tracker pixel, nor the Spam or older mail's pictures (${urls.filter((u) => /sendgrid|\/spam\/|\/before\//.test(u)).join(", ") || "none"})`);
  const ev = sq.prepare("SELECT detail FROM events WHERE kind = 'gmail_pic_fill'").all().map((r) => r.detail);
  check((progress(A).pics || []).length === 0 && ev.length === 1 && /read=2 queued=4 left=0/.test(ev[0]), `the noted list is done and logged (${ev.join(" | ")})`);
  // ---------- 2. the drain keeps them; the app's open is answered from R2 ----------
  const d = await mod.drainImgQueue(env);
  check(d.stored === 4, `the cron's drain keeps the four (${JSON.stringify(d)})`);
  const o = await open(pics("recent")[1], NOW - 2 * DAY);
  check(o.status === 200 && /^r2/.test(o.source || "") && o.asked === 0, `the app's open of a filled picture is answered from R2, asking the sender nothing (${JSON.stringify(o)})`);

  // ---------- 3. under half of the day's allowance left: the fill waits ----------
  const B = "robin.owner@gmail.com", gb = await connect(B);
  gb.put(["INBOX"], NOW - 3 * DAY, { k: "pat", from: '"Example Store" <hi@store.shop.example>' });
  sq.prepare("INSERT INTO events (at, kind, detail) VALUES (datetime('now'), 'img_prefetch', 'arrivals stored=600 bytes=1000')").run();
  await untilReady(B); const r0 = gb.fullReads; await once(B);
  check(gb.fullReads === r0 && (progress(B).pics || []).length === 1 && !rows().some((r) => /\/pat\//.test(r.url)), `with under half of the day's allowance left the fill waits (reads ${gb.fullReads - r0}, noted ${(progress(B).pics || []).length})`);
  sq.prepare("DELETE FROM events WHERE detail = 'arrivals stored=600 bytes=1000'").run(); await once(B);
  check(rows().filter((r) => /\/pat\//.test(r.url)).length === 2 && (progress(B).pics || []).length === 0, `and goes on once there is room (${rows().filter((r) => /\/pat\//.test(r.url)).length} queued)`);

  // ---------- 4. a rebuild notes only mail the hub did not have ----------
  sq.prepare("DELETE FROM img_queue").run();
  const late = g.put(["CATEGORY_PROMOTIONS", "INBOX"], NOW - 0.5 * DAY, { k: "late" });
  g.floor = g.hid + 1;   // Gmail has expired the mirror's cursor
  await once(A);   // → rebuild
  check(sq.prepare("SELECT mirror_state FROM gmail_accounts WHERE email = ?").get(A).mirror_state === "backfill", `an expired cursor starts a rebuild`);
  await untilReady(A);
  const noted2 = (progress(A).pics || []).map((x) => x[0]);
  check(JSON.stringify(noted2) === JSON.stringify([late]), `the rebuild notes only the mail the hub did not have (${noted2.map((id) => id === late ? "late" : id === newer ? "newer" : id === recent ? "recent" : id)})`);
} finally { globalThis.fetch = realFetch; }
console.log(fails.length ? `\n${fails.length} failed` : "\nall picture-fill checks passed");
process.exit(fails.length ? 1 : 0);
