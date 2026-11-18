#!/usr/bin/env node
// The hub's Gmail metadata mirror: the hub follows Gmail and every device follows the hub. Run against the REAL
// migrations on real SQLite, with D1 batches as transactions, and a fake Gmail that keeps a
// mailbox, a history log, the list and batch endpoints, and a count of every get. Checks the cases the design
// was changed for:
//  backfill takes its cursor first, lists the window and unread inbox, skips drafts, fetches in batches within the per-minute budget;
//  steady state applies label records, writes an explicit 'd' for every deletion, fetches only what it lacks, keeps stubs for old mail;
//  an older record never overwrites a newer get; a run that lost its lease writes nothing; past the page cap it resumes after the last
//  record; a 404 on the cursor rebuilds and the sweep deletes what Gmail no longer has; pruning turns aged rows into stubs and drops
//  old stubs without a feed event; the feed never puts a 'g|' id in `deleted`, and a 'u' for a pruned row is dropped, not deleted;
//  the full-mirror endpoint reads its cursor before its rows and says whether it is complete; the notification poll reads the mirror.
// Usage: node test/gmailmirror.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const fresh = () => {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of sql.split(/;\s*$/m)) { try { if (stmt.trim()) sq.exec(stmt); } catch (_) {} }
  }
  return sq;
};
const tick = () => new Promise((r) => setImmediate(r));
const big = (p) => p.some((x) => typeof x === "string" && x.length > 60_000);
const d1 = (sq) => ({
  prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a), all: async () => { await tick(); return { results: sq.prepare(sql).all(...p) }; }, first: async () => { await tick(); return sq.prepare(sql).get(...p) ?? null; }, run: async () => { await tick(); return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; }, _sql: sql, _p: p }); return mk([]); },
  batch: async (xs) => { await tick(); if (xs.some((x) => big(x._p))) throw new Error("D1: a bound parameter over 60 KB"); sq.exec("SAVEPOINT b"); try { const out = xs.map((x) => ({ meta: { changes: Number(sq.prepare(x._sql).run(...x._p).changes) } })); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } },
});
const SRC = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_gmailmirror.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

const DAY = 864e5, NOW = Date.now();
const gid = (ms, n) => Math.floor(ms).toString(16) + n.toString(16).padStart(5, "0");
// ---- a fake Gmail: one mailbox, its history, and every call counted ----
class Gmail {
  constructor() { this.msgs = new Map(); this.hist = []; this.hid = 5000; this.page = 500; this.gets = []; this.notifyGets = 0; this.expired = false; this.holdHistory = null; this.calls = []; }
  rec(r) { this.hid += 3; const h = { id: String(this.hid), ...r }; this.hist.push(h); return h.id; }
  put(id, labels, { days = 1, subject = "Subject " + id, from = "Sender <s@example.com>", record = true } = {}) {
    this.msgs.set(id, { id, threadId: "t" + id, labelIds: labels, internalDate: String(Math.floor(NOW - days * DAY)), snippet: "snippet " + id, subject, from, hid: this.hid });
    if (record) this.msgs.get(id).hid = Number(this.rec({ messagesAdded: [{ message: { id, threadId: "t" + id, labelIds: labels } }] }));
  }
  label(id, labels) { const m = this.msgs.get(id); m.labelIds = labels; m.hid = Number(this.rec({ labelsAdded: [{ message: { id, threadId: m.threadId, labelIds: labels }, labelIds: labels }] })); }
  del(id) { const m = this.msgs.get(id); this.msgs.delete(id); this.rec({ messagesDeleted: [{ message: { id, threadId: m?.threadId || "t" + id } }] }); }
  resource(m) { return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.snippet, historyId: String(m.hid), sizeEstimate: 100, payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "To", value: "me@gmail.example" }, { name: "Message-ID", value: `<${m.id}@x>` }] } }; }
  async fetch(url, o = {}) {
    const u = String(url), json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    this.calls.push(u);
    if (u === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    if (u === "https://gmail.googleapis.com/batch/gmail/v1") {
      const ids = [...String(o.body).matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)\?/g)].map((x) => x[1]); this.gets.push(...ids);
      const B = "batch_resp_x";
      const body = ids.map((id, k) => { const m = this.msgs.get(id); return `--${B}\r\nContent-Type: application/http\r\nContent-ID: <response-i${k}>\r\n\r\n` + (m ? `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.resource(m))}\r\n` : `HTTP/1.1 404 Not Found\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"error":{"code":404,"message":"Requested entity was not found."}}\r\n`); }).join("") + `--${B}--\r\n`;
      return new Response(body, { status: 200, headers: { "content-type": `multipart/mixed; boundary=${B}` } });
    }
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/";
    if (!u.startsWith(base)) return json({ error: "unmocked " + u }, 404);
    const path = u.slice(base.length), q = new URL(u).searchParams;
    if (path.startsWith("profile")) return json({ historyId: String(this.hid), emailAddress: "me@gmail.example" });
    if (path.startsWith("history?")) {
      if (this.holdHistory && !q.get("labelId")) { const h = this.holdHistory; this.holdHistory = null; await h; }
      if (this.expired) return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
      const start = Number(q.get("startHistoryId")), off = Number(q.get("pageToken") || 0);
      let recs = this.hist.filter((h) => Number(h.id) > start);
      if (q.get("labelId") === "INBOX") recs = recs.filter((h) => [...(h.messagesAdded || []), ...(h.labelsAdded || []), ...(h.labelsRemoved || [])].some((x) => (x.message.labelIds || []).includes("INBOX")));
      const pageRecs = recs.slice(off, off + this.page), more = off + this.page < recs.length;
      return json({ history: pageRecs, historyId: String(this.hid), ...(more ? { nextPageToken: String(off + this.page) } : {}) });
    }
    if (path.startsWith("messages?")) {
      const off = Number(q.get("pageToken") || 0); let list = [...this.msgs.values()];
      // Gmail's newer_than goes by arrival: on 2026-10-07 it listed five Spam messages whose internalDate is 1970 (ids from this month).
      if (q.get("q")?.startsWith("newer_than:90d")) list = list.filter((m) => Math.max(Number(m.internalDate), parseInt(m.id.slice(0, -5), 16)) >= NOW - 90 * DAY && !m.labelIds.includes("DRAFT") && (q.get("includeSpamTrash") === "true" || !m.labelIds.some((l) => l === "TRASH" || l === "SPAM")));
      else { const want = q.getAll("labelIds"); list = list.filter((m) => want.every((l) => m.labelIds.includes(l)) && !m.labelIds.some((l) => l === "TRASH" || l === "SPAM")); }
      const page = list.slice(off, off + 500);
      return json({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(off + 500 < list.length ? { nextPageToken: String(off + 500) } : {}) });
    }
    const one = path.match(/^messages\/([^/?]+)\?format=metadata&metadataHeaders=From&metadataHeaders=Subject/);
    if (one) { this.notifyGets++; const m = this.msgs.get(one[1]); return m ? json(this.resource(m)) : json({ error: { code: 404 } }, 404); }
    return json({ error: "unmocked " + u }, 404);
  }
}
const E = "me@gmail.example";
async function setup() {
  const sq = fresh(), db = d1(sq), g = new Gmail();
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
  const env = { DB: db, GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", FORWARD_TO: "x@gmail.com", DOMAINS: "yourdomain.example", CLI_TOKEN: "test-token", SESSION_SECRET: "s" };
  const sealed = await mod.sealToken(env, "refresh-token", E);
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, label) VALUES (?, ?, ?, 's', 'active', '2026-10-07', 'Me')").run(E, sealed.enc, sealed.iv);
  globalThis.fetch = (u, o) => g.fetch(u, o);
  const acct = () => sq.prepare("SELECT mirror_state, mirror_history_id, mirror_progress, mirror_synced_at FROM gmail_accounts WHERE email = ?").get(E);
  const row = (id) => sq.prepare("SELECT * FROM gmail_messages WHERE account = ? AND id = ?").get(E, id);
  const events = (after = 0) => sq.prepare("SELECT seq, thread_id, op FROM thread_changes WHERE seq > ? AND thread_id LIKE 'g|%' ORDER BY seq").all(after);
  const maxSeq = () => sq.prepare("SELECT COALESCE(MAX(seq), 0) mx FROM thread_changes").get().mx;
  const runUntilReady = async (n = 20) => { for (let i = 0; i < n && acct().mirror_state !== "ready"; i++) await mod.gmailMirrorOnce(env, E); };
  const call = (path) => mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { headers: { authorization: "Bearer test-token" } }), env, { waitUntil: () => {} }).then((r) => r.json());
  return { sq, db, g, env, acct, row, events, maxSeq, runUntilReady, call };
}
const realFetch = globalThis.fetch;
try {
  // ---------- backfill ----------
  {
    const t = await setup(); const { g, acct, row } = t;
    const ids = { w1: gid(NOW - 1 * DAY, 1), w2: gid(NOW - 2 * DAY, 2), tr: gid(NOW - 3 * DAY, 3), oldUnread: gid(NOW - 200 * DAY, 4), oldRead: gid(NOW - 200 * DAY, 5), draft: gid(NOW - 1 * DAY, 6) };
    g.put(ids.w1, ["INBOX", "UNREAD"]); g.put(ids.w2, ["CATEGORY_UPDATES"], { days: 2 }); g.put(ids.tr, ["TRASH"], { days: 3 });
    g.put(ids.oldUnread, ["INBOX", "UNREAD"], { days: 200 }); g.put(ids.oldRead, ["CATEGORY_PROMOTIONS"], { days: 200 }); g.put(ids.draft, ["DRAFT"]);
    const startHid = String(g.hid);
    await t.runUntilReady();
    const a = acct();
    check(a.mirror_state === "ready" && a.mirror_history_id === startHid, `the first fill ends ready, its cursor the historyId taken BEFORE listing (${a.mirror_state}, ${a.mirror_history_id} vs ${startHid})`);
    check(!!row(ids.w1)?.meta && !!row(ids.w2)?.meta && !!row(ids.tr)?.meta && !!row(ids.oldUnread)?.meta, "it holds the window (Trash included) and old unread inbox mail, with metadata");
    check(!row(ids.oldRead) && !row(ids.draft), "and not old read mail outside the inbox, nor drafts");
    const meta = JSON.parse(row(ids.w1).meta);
    check(meta.payload?.headers?.some((h) => h.name === "Subject") && JSON.parse(row(ids.w1).labels).includes("UNREAD"), "a row is the Gmail metadata resource with its labels");
    check(new Set(g.gets).size === g.gets.length && g.gets.length === 4, `each message is fetched once, in batch calls (${g.gets.length} gets)`);
    check(t.events().length === 4 && t.events().every((e) => e.op === "u"), `each stored message is one feed event ('g|<account>|<id>') (${t.events().length})`);
  }
  // ---------- the per-minute budget, held across runs ----------
  {
    const t = await setup(); const { g, acct } = t;
    for (let i = 0; i < 250; i++) g.put(gid(NOW - DAY - i * 1000, i), ["INBOX"], { record: false });
    const realNow = Date.now; Date.now = () => Math.floor(NOW / 60_000) * 60_000 + 1000;
    try {
      await mod.gmailMirrorOnce(env0(t), E); const after1 = g.gets.length;
      await mod.gmailMirrorOnce(env0(t), E); const after2 = g.gets.length;
      check(after1 === 150 && after2 === 150 && acct().mirror_state === "backfill", `150 gets in one minute, then none until the next (${after1}, ${after2})`);
      Date.now = () => Math.floor(NOW / 60_000) * 60_000 + 61_000;
      await t.runUntilReady();
      Date.now = () => Math.floor(NOW / 60_000) * 60_000 + 121_000; await t.runUntilReady();
      check(g.gets.length === 250 && acct().mirror_state === "ready", `the next minutes fetch the rest, each once (${g.gets.length})`);
    } finally { Date.now = realNow; }
  }
  // ---------- steady state ----------
  {
    const t = await setup(); const { g, acct, row } = t;
    const ids = { held: gid(NOW - DAY, 1), heldGone: gid(NOW - DAY, 2), stubOld: gid(NOW - 300 * DAY, 3), backIn: gid(NOW - 400 * DAY, 4), fresh: gid(NOW - 60e3, 5), flash: gid(NOW - 50e3, 6), draft: gid(NOW - 40e3, 7) };
    g.put(ids.held, ["INBOX", "UNREAD"]); g.put(ids.heldGone, ["INBOX"]);
    g.put(ids.stubOld, ["CATEGORY_UPDATES"], { days: 300 }); g.put(ids.backIn, ["CATEGORY_UPDATES"], { days: 400 });
    await t.runUntilReady(); await mod.gmailMirrorOnce(t.env, E);   // replay from the fill's cursor
    const seq0 = t.maxSeq(), gets0 = g.gets.length;
    g.label(ids.held, ["INBOX"]);                  // read on another device
    g.del(ids.heldGone);                           // deleted forever
    g.label(ids.stubOld, ["CATEGORY_UPDATES", "STARRED"]);   // old mail outside the mirror changes
    g.label(ids.backIn, ["INBOX", "CATEGORY_UPDATES"]);      // old mail moved back into the inbox
    g.put(ids.fresh, ["INBOX", "UNREAD"], { days: 0 });       // new mail
    g.put(ids.flash, ["INBOX", "UNREAD"], { days: 0 }); g.del(ids.flash);   // arrived and deleted between two runs
    g.put(ids.draft, ["DRAFT"], { days: 0 });
    const r = await mod.gmailMirrorOnce(t.env, E);
    const fetched = g.gets.slice(gets0);
    check(JSON.parse(row(ids.held).labels).join() === "INBOX", `a label record updates a held row with no get (${row(ids.held).labels})`);
    check(!row(ids.heldGone) && t.events(seq0).some((e) => e.thread_id === `g|${E}|${ids.heldGone}` && e.op === "d"), "a deletion removes the row and writes an explicit 'd'");
    check(t.events(seq0).some((e) => e.thread_id === `g|${E}|${ids.flash}` && e.op === "d") && !fetched.includes(ids.flash), "a message added and deleted between runs is never fetched, and its deletion is still told");
    check(row(ids.stubOld)?.meta === null && JSON.parse(row(ids.stubOld).labels).includes("STARRED"), "old mail outside the mirror that changes becomes a stub: labels only, for a device that holds it");
    check(!!row(ids.backIn)?.meta && fetched.includes(ids.backIn), "old mail moved back into the inbox is fetched in full (ee4ea36109)");
    check(!!row(ids.fresh)?.meta && !row(ids.draft) && !fetched.includes(ids.draft), "new mail is fetched; a draft is not");
    check(fetched.length === 2 && acct().mirror_history_id === String(g.hid) && !!acct().mirror_synced_at, `only what it lacked is fetched (${fetched.join(",")}), and the cursor reaches Gmail's current id`);
    check(r?.mirror && r.mirror.owed === 0, `nothing is left owed (${JSON.stringify(r?.mirror)})`);
    // an older record never overwrites a newer get: the row's labels came from a get stamped with a later history id
    const before = row(ids.fresh).labels;
    sq_exec(t, `UPDATE gmail_accounts SET mirror_history_id = '${Number(acct().mirror_history_id) - 30}' WHERE email = '${E}'`);   // replay records already applied
    await mod.gmailMirrorOnce(t.env, E);
    check(row(ids.fresh).labels === before, "replaying records older than a row's history id leaves the row as it is");
  }
  // ---------- a run that outlived its lease writes nothing ----------
  {
    const t = await setup(); const { g, row } = t;
    const id = gid(NOW - DAY, 1); g.put(id, ["INBOX", "UNREAD"]);
    await t.runUntilReady(); await mod.gmailMirrorOnce(t.env, E);
    g.label(id, ["INBOX"]);
    let open; g.holdHistory = new Promise((r) => { open = r; });
    const slow = mod.gmailMirrorOnce(t.env, E);           // reads history, then waits
    await tick(); await tick();
    g.label(id, ["INBOX", "STARRED"]);
    await mod.gmailMirrorOnce(t.env, E);                   // a second run commits first
    const mid = row(id).labels;
    open(); const rs = await slow;
    check(mid.includes("STARRED") && row(id).labels === mid && /nothing written/.test(String(rs?.mirror)), `the slower run finds the cursor moved and writes nothing (${JSON.stringify(rs?.mirror)}; labels ${row(id).labels})`);
  }
  // ---------- past the page cap it resumes after the last record it read ----------
  {
    const t = await setup(); const { g, acct } = t;
    const ids = []; for (let i = 0; i < 4; i++) { const id = gid(NOW - DAY, i); ids.push(id); g.put(id, ["INBOX", "UNREAD"]); }
    await t.runUntilReady(); await mod.gmailMirrorOnce(t.env, E);
    g.page = 1; for (let k = 0; k < 60; k++) g.label(ids[k % 4], k % 2 ? ["INBOX"] : ["INBOX", "UNREAD"]);
    const target = g.hist[g.hist.length - 1].id;
    const r1 = await mod.gmailMirrorOnce(t.env, E); const c1 = acct().mirror_history_id;
    check(r1.mirror.more === true && c1 === g.hist[g.hist.length - 11].id, `50 pages, then the cursor is the last record read, not the page's historyId (${c1})`);
    await mod.gmailMirrorOnce(t.env, E);
    check(acct().mirror_history_id === String(g.hid) && JSON.parse(t.row(ids[3]).labels).join() === "INBOX", `the next run reads the rest (${acct().mirror_history_id} vs ${target})`);
  }
  // ---------- 404: rebuild, and the sweep deletes what Gmail no longer has ----------
  {
    const t = await setup(); const { g, acct, row } = t;
    const keep = gid(NOW - DAY, 1), lost = gid(NOW - DAY, 2); g.put(keep, ["INBOX"]); g.put(lost, ["INBOX"]);
    await t.runUntilReady(); await mod.gmailMirrorOnce(t.env, E);
    g.msgs.delete(lost); g.expired = true;                 // gone in Gmail, and Gmail forgot our cursor
    const r = await mod.gmailMirrorOnce(t.env, E);
    check(r.mirror === "rebuild" && acct().mirror_state === "backfill", "an expired cursor starts a rebuild");
    g.expired = false; const seq0 = t.maxSeq();
    await t.runUntilReady();
    check(acct().mirror_state === "ready" && !!row(keep)?.meta && !row(lost) && t.events(seq0).some((e) => e.thread_id === `g|${E}|${lost}` && e.op === "d"), "the rebuild keeps what Gmail lists and deletes, with a 'd', what it no longer has");
  }
  // ---------- pruning, the feed, and the full mirror ----------
  {
    const t = await setup(); const { g, sq, row } = t;
    const live = gid(NOW - DAY, 1), aged = gid(NOW - DAY, 2), gone = gid(NOW - DAY, 3), oldStub = gid(NOW - 300 * DAY, 4);
    g.put(live, ["INBOX", "UNREAD"]); g.put(aged, ["CATEGORY_UPDATES"]); g.put(gone, ["INBOX"]);
    await t.runUntilReady(); await mod.gmailMirrorOnce(t.env, E);
    const seq0 = t.maxSeq();
    g.del(gone); await mod.gmailMirrorOnce(t.env, E);
    // the device's view of the feed since seq0
    const f = await t.call(`/api/threads?limit=500&since_seq=${seq0}`);
    check(!(f.deleted || []).some((k) => String(k).startsWith("g|")) && (f.gmail_deleted || []).some((d) => d.id === gone && d.account === E), `the feed never puts a 'g|' id in deleted; a Gmail deletion comes as gmail_deleted (${JSON.stringify(f.deleted)})`);
    check(f.gmail_status?.[E]?.state === "ready" && f.gmail_status[E].owed === 0, `every feed page says how each account's mirror stands (${JSON.stringify(f.gmail_status)})`);
    const all = await t.call(`/api/threads?limit=500&since_seq=0`);
    check((all.gmail || []).some((r) => r.id === live && r.meta && JSON.parse(r.labels).includes("UNREAD")), "a stored message reaches the device as a row with its metadata and labels");
    // prune: the aged row becomes a stub (a 'u' event), an old stub is dropped silently
    sq.prepare("UPDATE gmail_messages SET internal_date = ? WHERE id = ?").run(NOW - 200 * DAY, aged);
    sq.prepare("INSERT INTO gmail_messages (account, id, thread_id, labels, internal_date, meta, history_id, updated_at) VALUES (?, ?, 't', '[]', NULL, NULL, NULL, ?)").run(E, oldStub, new Date(NOW - 40 * DAY).toISOString());
    const seq1 = t.maxSeq();
    await mod.default.scheduled(   // the daily 09:00 UTC maintenance run, which prunes the mirror
{ scheduledTime: Date.UTC(2026, 9, 8, 9, 0) }, { ...t.env, GMAIL_CLIENT_ID: "" }, { waitUntil: () => {} }).catch(() => {});
    const pruned = row(aged), evs = t.events(seq1);
    check(pruned && pruned.meta === null && evs.some((e) => e.thread_id === `g|${E}|${aged}` && e.op === "u"), "pruning turns a row that left the window and the inbox into a stub, and says so");
    check(!row(oldStub) && !evs.some((e) => e.thread_id === `g|${E}|${oldStub}`), "and drops a stub older than the feed, without an event");
    // a 'u' whose row is gone is dropped, not reported deleted
    sq.prepare("DELETE FROM gmail_messages WHERE id = ?").run(live);
    const f2 = await t.call(`/api/threads?limit=500&since_seq=0`);
    check(!(f2.gmail || []).some((r) => r.id === live) && !(f2.gmail_deleted || []).some((d) => d.id === live), "a 'u' event for a row that is gone is dropped: only an explicit 'd' deletes");
    // the full mirror (two rows to page through)
    g.put(gid(NOW - DAY, 9), ["INBOX"]); await mod.gmailMirrorOnce(t.env, E);
    const m = await t.call(`/api/gmail/mirror?account=${encodeURIComponent(E)}&limit=1`);
    check(Number.isFinite(m.cursor) && m.complete === true && Array.isArray(m.owed) && m.rows.length === 1 && !!m.next, `the full mirror pages, with its cursor and whether it is complete (${JSON.stringify({ cursor: m.cursor, complete: m.complete, next: m.next })})`);
    const m2 = await t.call(`/api/gmail/mirror?account=${encodeURIComponent(E)}&limit=1&after=${encodeURIComponent(m.next)}`);
    check(m2.cursor === undefined && m2.rows.length === 1, "later pages carry rows only: the device keeps the first page's cursor");
  }
  // ---------- the notification poll reads the mirror ----------
  {
    const t = await setup(); const { g } = t;
    const id0 = gid(NOW - DAY, 1); g.put(id0, ["INBOX"]);
    await t.runUntilReady();
    t.sq.prepare("UPDATE gmail_accounts SET poll_history_id = ? WHERE email = ?").run(String(g.hid), E);
    await mod.gmailMirrorOnce(t.env, E);
    const id = gid(NOW - 10e3, 2); g.put(id, ["INBOX", "UNREAD"], { days: 0, subject: "Lunch?", from: "Grace <grace@example.com>" });
    let rulesRead = 0; const rules = async () => { rulesRead++; return []; };
    const r = await mod.gmailPollAccount(t.env, { email: E }, rules, "all");
    check(r.new === 1 && g.notifyGets === 0 && !!t.row(id)?.meta, `new inbox mail is screened from the mirror's copy, with no second get (${JSON.stringify({ new: r.new, notifyGets: g.notifyGets })})`);
    check(rulesRead === 1, `the sender rules are read once, because there was mail to screen (${rulesRead})`);
    const r2 = await mod.gmailPollAccount(t.env, { email: E }, async () => { rulesRead++; return []; }, "all");
    check(rulesRead === 1 && r2.new === 0, `a poll with nothing new reads no rules (${rulesRead})`);
  }
  // ---------- large metadata: parameters stay under 60 KB ----------
  {
    const t = await setup(); const { g } = t;
    for (let i = 0; i < 120; i++) g.put(gid(NOW - DAY - i * 1000, i), ["INBOX"], { record: false, subject: "S".repeat(2000) + i });
    await t.runUntilReady();
    check(t.acct().mirror_state === "ready" && t.sq.prepare("SELECT COUNT(*) n FROM gmail_messages WHERE meta IS NOT NULL").get().n === 120, "120 rows of 2 KB each are written in batches whose parameters stay under 60 KB (0e97e22242)");
  }
  // ---------- spam with a 1970 internalDate is still in the window: its id says when it arrived ----------
  {
    const t = await setup(); const { g, row } = t;
    const spam = gid(NOW - 3 * DAY, 1); g.put(spam, ["SPAM", "UNREAD"], { days: 3 }); g.msgs.get(spam).internalDate = "86400000";
    await t.runUntilReady();
    check(!!row(spam)?.meta && row(spam).internal_date >= NOW - 4 * DAY, `a message whose internalDate is 1970 but which arrived this week is mirrored in full and dated by its arrival (${row(spam)?.internal_date})`);
  }
  // ---------- what history never reported is found by re-listing ----------
  {
    const t = await setup(); const { g, row } = t;
    g.put(gid(NOW - DAY, 1), ["INBOX"]); await t.runUntilReady(); await mod.gmailMirrorOnce(t.env, E);
    const silent = gid(NOW - 3600e3, 2); g.put(silent, ["INBOX", "UNREAD"], { days: 0.04, record: false });   // arrived, no history record
    await mod.gmailMirrorOnce(t.env, E);
    check(!row(silent), "a message with no history record is not seen by the history pass");
    t.sq.prepare("UPDATE gmail_accounts SET mirror_progress = json_set(mirror_progress, '$.rc', 0) WHERE email = ?").run(E);
    await mod.gmailMirrorOnce(t.env, E);
    check(!!row(silent)?.meta, "the ten-minute re-list of the last two days finds it and fetches it");
  }
  // ---------- the new endpoint needs the CLI token or a session ----------
  {
    const t = await setup();
    const r = await mod.default.fetch(new Request(`https://mail.yourdomain.example/api/gmail/mirror?account=${encodeURIComponent(E)}`), t.env, { waitUntil: () => {} });
    check(r.status === 401, `GET /api/gmail/mirror without credentials is refused (${r.status})`);
  }
  // ---------- the notification poll past its 20-page cap resumes after the last record it read ----------
  {
    const t = await setup(); const { g } = t;
    g.put(gid(NOW - DAY, 1), ["INBOX"]); await t.runUntilReady();
    t.sq.prepare("UPDATE gmail_accounts SET poll_history_id = ? WHERE email = ?").run(String(g.hid), E);
    g.page = 1; for (let i = 0; i < 25; i++) g.put(gid(NOW - 60e3 + i, 10 + i), ["INBOX", "UNREAD"], { days: 0 });
    const inboxRecs = g.hist.slice(-25).map((h) => h.id);
    const r1 = await mod.gmailPollAccount(t.env, { email: E }, async () => [], "all");
    const c1 = t.sq.prepare("SELECT poll_history_id c FROM gmail_accounts WHERE email = ?").get(E).c;
    check(r1.new === 20 && c1 === inboxRecs[19], `20 pages, then the notification cursor is the last record read, not the mailbox's current id (${r1.new} new, cursor ${c1} vs record ${inboxRecs[19]}, current ${g.hid})`);
    const r2 = await mod.gmailPollAccount(t.env, { email: E }, async () => [], "all");
    check(r2.new === 5, `the next poll notifies the other 5, so none is skipped (${r2.new})`);
  }
  // ---------- off and shadow ----------
  {
    const t = await setup(); const { g } = t;
    check((await mod.gmailMirrorOnce({ ...t.env, GMAIL_MIRROR: "off" }, E)) === null, "GMAIL_MIRROR=off turns the mirror off");
    g.put(gid(NOW - DAY, 1), ["INBOX"]);
    const sh = { ...t.env, GMAIL_MIRROR: "shadow" };
    for (let i = 0; i < 5 && t.acct().mirror_state !== "ready"; i++) await mod.gmailMirrorOnce(sh, E);
    const f = await mod.default.fetch(new Request("https://mail.yourdomain.example/api/threads?limit=500&since_seq=0", { headers: { authorization: "Bearer test-token" } }), sh, { waitUntil: () => {} }).then((r) => r.json());
    check(t.acct().mirror_state === "ready" && f.gmail_status?.[E]?.state === null, `GMAIL_MIRROR=shadow fills the mirror but tells devices nothing, so they keep syncing Gmail directly (${JSON.stringify(f.gmail_status)})`);
    const off = await mod.default.fetch(new Request("https://mail.yourdomain.example/api/threads?limit=500&since_seq=0", { headers: { authorization: "Bearer test-token" } }), { ...t.env, GMAIL_MIRROR: "off" }, { waitUntil: () => {} }).then((r) => r.json());
    check(off.gmail_status?.[E]?.state === null, `GMAIL_MIRROR=off tells devices nothing too, so a switched device goes back to Gmail (3d50e182ce) (${JSON.stringify(off.gmail_status)})`);
  }
  // ---------- the daily unread pass re-reads a stored copy that disagrees ----------
  {
    const t = await setup(); const { g, row, sq } = t; const id = gid(NOW - 1 * DAY, 77);
    g.put(id, ["INBOX", "UNREAD"]); await t.runUntilReady(); await mod.gmailMirrorOnce(t.env, E);
    sq.prepare("UPDATE gmail_messages SET labels = ? WHERE account = ? AND id = ?").run(JSON.stringify(["INBOX"]), E, id);   // history missed the label: stored as read
    const pr = JSON.parse(t.acct().mirror_progress || "{}"); pr.ru = 0; pr.rc = Date.now(); sq.prepare("UPDATE gmail_accounts SET mirror_progress = ? WHERE email = ?").run(JSON.stringify(pr), E);
    const gets0 = g.gets.length; await mod.gmailMirrorOnce(t.env, E);
    const l = JSON.parse(row(id)?.labels || "[]");
    check(l.includes("UNREAD") && g.gets.slice(gets0).includes(id), `unread pass: a stored copy that says read while Gmail lists it unread is re-read, and is unread again (${JSON.stringify(l)}, re-read ${g.gets.slice(gets0).includes(id)})`);
    const gets1 = g.gets.length; const pr2 = JSON.parse(t.acct().mirror_progress || "{}"); pr2.ru = 0; pr2.rc = Date.now(); sq.prepare("UPDATE gmail_accounts SET mirror_progress = ? WHERE email = ?").run(JSON.stringify(pr2), E);
    await mod.gmailMirrorOnce(t.env, E);
    check(!g.gets.slice(gets1).includes(id), "unread pass: a copy that agrees is not read again");
  }
} finally { globalThis.fetch = realFetch; }
function env0(t) { return t.env; }
function sq_exec(t, sql) { t.sq.exec(sql); }
console.log(fails.length ? `\n${fails.length} FAILED:\n` + fails.map((f) => "  " + f).join("\n") : "\nall Gmail mirror checks passed");
process.exit(fails.length ? 1 : 0);
