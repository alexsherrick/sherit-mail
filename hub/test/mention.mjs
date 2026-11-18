#!/usr/bin/env node
// "Delete unless it mentions" rules. The real Worker's Gmail poll and mirror, real migrations on real SQLite (D1 batches
// as transactions), and a fake Gmail that keeps a mailbox, its history, full message bodies, and every trash and modify call.
//  - the words: whole visible text, never the user's own address, a URL or markup; a word starts a word; a phrase may wrap;
//  - the rules: an address beats a domain, a domain covers subdomains but not look-alikes, an account rule beats an every-account one;
//  - the poll: a mention keeps and notifies; none trashes and does not notify; unreadable keeps; other senders untouched;
//  an address-level block still wins;
//  - spam (handed over by the mirror): a mention moves it to the inbox and notifies; none trashes; other senders stay in Spam;
//  - once: a replayed history, or a mail the user restored, is never decided again;
//  - the API refuses what it should, and the daily report lists what was deleted.
// Usage: node test/mention.mjs (exit 1 on any failed check)
// CONTROL: MENTION_SRC=<an index.js from before the fix> node test/mention.mjs must fail.
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
const d1 = (sq) => ({
  prepare(sql) { const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a), all: async () => { await tick(); return { results: sq.prepare(sql).all(...p) }; }, first: async () => { await tick(); return sq.prepare(sql).get(...p) ?? null; }, run: async () => { await tick(); return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; } }); return mk([]); },
  batch: async (xs) => { await tick(); sq.exec("SAVEPOINT b"); try { const out = xs.map((x) => ({ meta: { changes: Number(sq.prepare(x._sql).run(...x._p).changes) } })); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } },
});
const SRC = readFileSync(process.env.MENTION_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_mention_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));
const has = (f) => typeof mod[f] === "function";

const DAY = 864e5, NOW = Date.now();
let seq = 0; const gid = () => Math.floor(NOW).toString(16) + (++seq).toString(16).padStart(5, "0");
const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const E = "sam.owner.sxsw@gmail.com";
// ---- a fake Gmail: one mailbox, its history, full bodies, and every trash / modify ----
class Gmail {
  constructor() { this.msgs = new Map(); this.hist = []; this.hid = 5000; this.trashed = []; this.modified = []; this.failFull = new Set(); this.trashFail = new Map(); this.flipOnFull = new Map(); this.failMinimal = new Set(); this.threadGets = 0; }
  rec(r) { this.hid += 3; const h = { id: String(this.hid), ...r }; this.hist.push(h); return h.id; }
  put(labels, { from, subject = "Hello", plain = null, html = null, htmlApart = false, cal = null, thread = null, ar = null }) {
    const id = gid(), threadId = thread || "t" + id;
    this.msgs.set(id, { id, threadId, labelIds: labels, internalDate: String(NOW), snippet: (plain || "").slice(0, 80), subject, from, plain, html, htmlApart, cal, ar });
    this.msgs.get(id).hid = Number(this.rec({ messagesAdded: [{ message: { id, threadId, labelIds: labels } }] }));
    return id;
  }
  label(id, labels) { const m = this.msgs.get(id); m.labelIds = labels; m.hid = Number(this.rec({ labelsAdded: [{ message: { id, threadId: m.threadId, labelIds: labels }, labelIds: labels }] })); }
  headers(m) { return [...(m.ar ? [{ name: "Authentication-Results", value: m.ar }] : []), { name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "To", value: E }, { name: "Message-ID", value: `<${m.id}@x>` }]; }
  resource(m, full) {
    const r = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.snippet, historyId: String(m.hid), sizeEstimate: 100 };
    if (!full) return { ...r, payload: { mimeType: "text/plain", headers: this.headers(m) } };
    const parts = [];
    if (m.plain !== null) parts.push({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64u(m.plain), size: m.plain.length } });
    if (m.html !== null) parts.push({ mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: m.htmlApart ? { attachmentId: "big1", size: 900000 } : { data: b64u(m.html), size: m.html.length } });
    if (m.cal !== null) parts.push({ mimeType: "text/calendar", headers: [{ name: "Content-Type", value: 'text/calendar; charset="UTF-8"; method=REQUEST' }], body: { data: b64u(m.cal), size: m.cal.length } });
    return { ...r, payload: { mimeType: "multipart/alternative", headers: this.headers(m), parts } };
  }
  async fetch(url, o = {}) {
    const u = String(url), json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    if (u === "https://gmail.googleapis.com/batch/gmail/v1") {
      const ids = [...String(o.body).matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)\?/g)].map((x) => x[1]), B = "batch_resp_x";
      const body = ids.map((id, k) => { const m = this.msgs.get(id); return `--${B}\r\nContent-Type: application/http\r\nContent-ID: <response-i${k}>\r\n\r\n` + (m ? `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.resource(m))}\r\n` : `HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"code":404}}\r\n`); }).join("") + `--${B}--\r\n`;
      return new Response(body, { status: 200, headers: { "content-type": `multipart/mixed; boundary=${B}` } });
    }
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/";
    if (!u.startsWith(base)) return json({ error: "unmocked " + u }, 404);
    const path = u.slice(base.length), q = new URL(u).searchParams;
    if (path.startsWith("profile")) return json({ historyId: String(this.hid), emailAddress: E });
    if (path.startsWith("history?")) {
      const start = Number(q.get("startHistoryId"));
      let recs = this.hist.filter((h) => Number(h.id) > start);
      if (q.get("labelId") === "INBOX") recs = recs.filter((h) => [...(h.messagesAdded || []), ...(h.labelsAdded || []), ...(h.labelsRemoved || [])].some((x) => (x.message.labelIds || []).includes("INBOX")));
      return json({ history: recs, historyId: String(this.hid) });
    }
    if (path.startsWith("messages?")) return json({ messages: [...this.msgs.values()].filter((m) => !m.labelIds.includes("TRASH")).map((m) => ({ id: m.id, threadId: m.threadId })) });
    let x;
    if ((x = path.match(/^messages\/([^/?]+)\/trash$/)) && o.method === "POST") {
      const how = this.trashFail.get(x[1]);   // "refuse": nothing happens; "lost": it happens, the answer is lost
      if (how === "refuse") return json({ error: { code: 500, message: "backend error" } }, 500);
      this.trashed.push(x[1]); this.label(x[1], ["TRASH"]);
      return how === "lost" ? json({ error: { code: 503, message: "unavailable" } }, 503) : json({ id: x[1] });
    }
    if ((x = path.match(/^threads\/([^/?]+)\?format=minimal$/))) { this.threadGets++; return json({ id: x[1], messages: [...this.msgs.values()].filter((m) => m.threadId === x[1]).map((m) => ({ id: m.id, labelIds: m.labelIds })) }); }
    if ((x = path.match(/^messages\/([^/?]+)\?format=minimal$/))) { if (this.failMinimal.has(x[1])) return json({ error: { code: 500 } }, 500); const m = this.msgs.get(x[1]); return m ? json({ id: m.id, labelIds: m.labelIds }) : json({ error: { code: 404 } }, 404); }
    if ((x = path.match(/^messages\/([^/?]+)\/modify$/)) && o.method === "POST") { const b = JSON.parse(o.body); this.modified.push({ id: x[1], ...b }); const m = this.msgs.get(x[1]); this.label(x[1], [...m.labelIds.filter((l) => !(b.removeLabelIds || []).includes(l)), ...(b.addLabelIds || [])]); return json({ id: x[1] }); }
    if ((x = path.match(/^messages\/([^/?]+)\?format=full$/))) {
      const m = this.msgs.get(x[1]); if (this.failFull.has(x[1])) return json({ error: { code: 500, message: "backend error" } }, 500);
      if (this.flipOnFull.has(x[1])) { this.label(x[1], this.flipOnFull.get(x[1])); this.flipOnFull.delete(x[1]); }   // the user moves it in that moment
      return m ? json(this.resource(m, true)) : json({ error: { code: 404 } }, 404);
    }
    if ((x = path.match(/^messages\/([^/?]+)\?format=metadata/))) { const m = this.msgs.get(x[1]); return m ? json(this.resource(m)) : json({ error: { code: 404 } }, 404); }
    return json({ error: "unmocked " + u }, 404);
  }
}
const realFetch = globalThis.fetch;
async function setup() {
  const sq = fresh(), db = d1(sq), g = new Gmail(), sent = [];
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
  const env = { DB: db, GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", FORWARD_TO: "sam.owner@gmail.com", DOMAINS: "yourdomain.example", CLI_TOKEN: "test-token", SESSION_SECRET: "s",
    EMAIL: { send: async (m) => { sent.push(m); } } };
  const sealed = await mod.sealToken(env, "refresh-token", E);
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, label) VALUES (?, ?, ?, 's', 'active', '2026-10-07', 'SXSW')").run(E, sealed.enc, sealed.iv);
  globalThis.fetch = (u, o) => g.fetch(u, o);
  for (let i = 0; i < 20 && sq.prepare("SELECT mirror_state FROM gmail_accounts WHERE email = ?").get(E).mirror_state !== "ready"; i++) await mod.gmailMirrorOnce(env, E);
  const poll = (policy = "all") => mod.gmailPollAccount(env, { email: E }, async () => sq.prepare("SELECT pattern, action, scope, category FROM sender_rules").all(), policy);
  await poll();   // takes the poll's first cursor
  const api = async (method, path, body) => { const r = await mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json", origin: "https://mail.yourdomain.example" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: () => {} }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const decision = (id) => sq.prepare("SELECT decision FROM mention_decisions WHERE account = ? AND id = ?").get(E, id)?.decision ?? null;
  const notified = () => sq.prepare("SELECT detail FROM events WHERE kind = 'gmail_poll' ORDER BY id").all().map((r) => r.detail).join("\n");
  return { sq, db, g, env, sent, poll, api, decision, notified };
}

try {
  // ---------- the words ----------
  if (has("mentionsAny")) {
    const own = [E, "sam.owner@gmail.com", "sam@domain5.example"], W = ["SXSW", "South by Southwest"];
    const yes = (t, why) => check(mod.mentionsAny(t, W, own) === true, `a mention: ${why}`);
    const no = (t, why) => check(mod.mentionsAny(t, W, own) === false, `not a mention: ${why}`);
    yes({ html: ["<p>See you at <b>SXSW</b> 2027</p>"] }, "SXSW in the HTML's text");
    yes({ plain: ["Panels for #SXSW and SXSWedu announced"] }, "#SXSW and SXSWedu");
    yes({ plain: ["Live from South by\n  Southwest this March"] }, "a phrase broken across lines");
    yes({ subject: "Your SXSW badge", plain: ["x"] }, "the subject");
    yes({ html: ['<img src="cid:a" alt="SXSW 2027 lineup">'] }, "a picture's alt text");
    yes({ html: ["<p>S&#88;SW &amp; friends</p>"] }, "an HTML entity spelling it");
    no({ plain: ["Hi sam.owner.sxsw, Claim Your Free Kobalt Tool Set"] }, "spam greeting the SXSW address (the 2026-10-15 Lowe's spam)");
    no({ plain: ["This email was sent to sam.owner.sxsw@gmail.com. Unsubscribe."] }, "the unsubscribe footer naming the address");
    no({ plain: ["Manage: https://e.uber.com/pref?email=sam.owner.sxsw%40gmail.com&utm_campaign=sxsw2026"] }, "a URL, even one carrying the word");
    no({ html: ['<a href="https://sxsw.com/register">Register</a>'] }, "a link's address, not its text");
    no({ html: ["<style>.sxsw{color:red}</style><p>Trip receipt</p>"] }, "a style sheet");
    no({ plain: ["mxsxsw is not it"] }, "letters inside another word");
    no({ subject: "Security alert for sam.owner.sxsw@gmail.com", plain: ["A new sign-in"] }, "a Google alert naming the account");
    // Words split by markup, entities, zero-width characters, unquoted alt, visible links, plus-addresses
    yes({ html: ["<p>Our SX<b>SW</b> week</p>"] }, "a word split by inline markup (c98d3935f6)");
    yes({ html: ["<span>SX</span><span style=color:red>SW</span>"] }, "a word split across spans");
    yes({ html: ["<p>Austin</p><p>SXSW</p>"] }, "block elements still separate words");
    yes({ html: ["<img src=cid:a alt=SXSW>"] }, "an unquoted alt (64e4df8be3)");
    yes({ plain: ["SX\u200bSW is back"] }, "a zero-width space inside the word (554a523d3d)");
    yes({ html: ["<p>SX&zwnj;SW is back</p>"] }, "a zero-width entity inside the word");
    yes({ html: ["<p>South&thinsp;by&thinsp;Southwest</p>"] }, "an entity the decoder does not name (61ae22a858)");
    yes({ plain: ["Badges at https://www.sxsw.com/2027/badges"] }, "a link you can read keeps its host (1ad87daa90)");
    no({ plain: ["Sent to sam.owner.sxsw+promo@gmail.com"] }, "the SXSW address with a plus tag");
    check(mod.mentionScan({ html: ['<img src="cid:x"><p>View online</p>'] }, W, own).chars < 20, "a picture-only mail has almost no text of its own (831aca9b68)");
  } else check(false, "mentionsAny is exported");
  if (has("matchMention")) {
    const R = [{ id: "d", pattern: "*@listings.example", scope: "*" }, { id: "s", pattern: "*@updates.listings.example", scope: "*" }, { id: "a", pattern: "x@updates.listings.example", scope: "*" }, { id: "acct", pattern: "*@uber.com", scope: E }, { id: "all", pattern: "*@uber.com", scope: "*" }];
    const w = (addr, acct = E) => mod.matchMention(R, addr, acct)?.id ?? null;
    check(w("n@ppt.listings.example") === "d" && w("n@updates.listings.example") === "s" && w("x@updates.listings.example") === "a", "a domain covers its subdomains; a longer domain and then an address win");
    check(w("n@notlistings.example") === null && w("n@listings.example.evil.io") === null, "a look-alike domain is not covered");
    check(w("noreply@uber.com") === "acct" && w("noreply@uber.com", "other@gmail.com") === "all", "a rule for this account beats one for every account, and only applies to it");
  } else check(false, "matchMention is exported");

  // ---------- the poll, the mirror's spam, once only ----------
  {
    const t = await setup(); const { g, sq, api, decision } = t;
    const add = await api("POST", "/api/mention-rules", { pattern: "*@musicnews.example", words: "SXSW, South by Southwest", scope: E });
    check(add.status === 200 && JSON.stringify(add.body?.rule?.words) === '["SXSW","South by Southwest"]', `a rule is added through the API (${add.status})`);
    for (const p of ["*@uber.com", "*@zine.example", "*@venue.example", "*@stubhub.com", "*@homeshow.example"]) await api("POST", "/api/mention-rules", { pattern: p, words: ["SXSW", "South by Southwest"], scope: E });
    const ids = {
      keep: g.put(["INBOX", "CATEGORY_UPDATES"], { from: "Music News <news@musicnews.example>", subject: "This week", html: "<p>Our <b>SXSW</b> 2027 showcase lineup</p>" }),
      drop: g.put(["INBOX"], { from: "Uber Receipts <noreply@uber.com>", subject: "Your Thursday trip", plain: "Hi sam.owner.sxsw, thanks for riding. Sent to sam.owner.sxsw@gmail.com. https://e.uber.com/?utm=sxsw", html: "<p>Thanks for riding</p>" }),
      other: g.put(["INBOX"], { from: "Friend <friend@example.com>", subject: "Dinner?", plain: "Are you free" }),
      apart: g.put(["INBOX"], { from: "Venue <news@events.venue.example>", subject: "On sale", plain: "Tickets on sale Friday", htmlApart: true, html: "" }),
      fail: g.put(["INBOX"], { from: "Zine <hello@zine.example>", subject: "Issue 4", plain: "Nothing here" }),
      phrase: g.put(["INBOX"], { from: "Zine <hellospin@zine.example>", subject: "Issue 5", plain: "Recorded at South by\nSouthwest" }),
      look: g.put(["INBOX"], { from: "Fake <hello@notzine.example>", subject: "Hi", plain: "Nothing" }),
    };
    g.failFull.add(ids.fail);
    const GPASS = "mx.google.com; dkim=pass header.i=@stubhub.com header.s=s1 header.b=abcdef; spf=pass (google.com: domain of bounce@stubhub.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@stubhub.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=stubhub.com";
    const spam = {
      // Spam is acted on only with Gmail's own DMARC pass for the From domain.
      rescue: g.put(["SPAM"], { from: "StubHub <promo@stubhub.com>", subject: "Austin in March", plain: "Get SXSW passes before they go", ar: GPASS }),
      dump: g.put(["SPAM"], { from: "StubHub <promo@stubhub.com>", subject: "Deals", plain: "Cheap seats for every show this weekend, while they last", ar: GPASS }),
      spoof: g.put(["SPAM"], { from: "StubHub <promo@stubhub.com>", subject: "SXSW badge", plain: "Your SXSW badge is waiting", ar: "mx.google.com; spf=pass (google.com: domain of x@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@evil.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=stubhub.com" }),
      scam: g.put(["SPAM"], { from: '"Lowe\'s-Rewards" <XqWzRbVM@spam.example>', subject: "sam.owner.sxsw, Claim Your Free Kobalt Tool Set", plain: "SXSW winners" }),
    };
    const r = await t.poll("priority");   // "Priority only": nothing here would notify but what a rule kept or moved out of spam
    check(decision(ids.keep) === "kept" && !g.trashed.includes(ids.keep), `a mail that mentions SXSW stays (${decision(ids.keep)})`);
    check(/new=7 blocked=0 notified=3 /.test(t.notified()), `the two kept and the one moved out of spam notify, as priority; nothing else does (${t.notified()})`);
    check(decision(ids.drop) === "dropped" && g.trashed.includes(ids.drop), `a mail that only names the SXSW address, in a greeting, a footer and a URL, goes to the trash (${decision(ids.drop)})`);
    check(decision(ids.other) === null && !g.trashed.includes(ids.other) && decision(ids.look) === null && !g.trashed.includes(ids.look), "a sender with no rule, or a look-alike domain, is not touched");
    check(decision(ids.apart) === "unread" && !g.trashed.includes(ids.apart), `a mail whose HTML Gmail keeps apart is not read in full, so it is kept (${decision(ids.apart)})`);
    check(decision(ids.fail) === "unread" && !g.trashed.includes(ids.fail), `a mail Gmail will not give in full is kept (${decision(ids.fail)})`);
    check(decision(ids.phrase) === "kept", `"South by Southwest" across a line break keeps it (${decision(ids.phrase)})`);
    check(decision(spam.rescue) === "rescued" && t.g.modified.some((x) => x.id === spam.rescue && x.addLabelIds?.includes("INBOX") && x.removeLabelIds?.includes("SPAM")), `spam from a rule's sender that mentions SXSW is moved to the inbox (${decision(spam.rescue)})`);
    check(decision(spam.dump) === "dropped" && g.trashed.includes(spam.dump), `spam from a rule's sender that does not goes to the trash (${decision(spam.dump)})`);
    check(decision(spam.scam) === null && g.msgs.get(spam.scam).labelIds.includes("SPAM") && !g.modified.some((x) => x.id === spam.scam), "spam from anyone else stays in Spam, whatever it says");
    check(decision(spam.spoof) === null && g.msgs.get(spam.spoof).labelIds.includes("SPAM") && !g.modified.some((x) => x.id === spam.spoof), "spam that only says it is from a rule's sender (no DMARC pass) stays in Spam, though it mentions SXSW");
    check(r?.dropped === 2 && !("spam" in (r.mirror || {})), `the poll reports what it deleted (${JSON.stringify({ dropped: r?.dropped, new: r?.new })})`);
    const rule = sq.prepare("SELECT kept, dropped FROM mention_rules WHERE pattern = '*@uber.com'").get();
    check(rule?.dropped === 1 && rule?.kept === 0, `each rule counts what it did (${JSON.stringify(rule)})`);
    // once only: nothing new, a replayed history, a mail the user restored
    const trashed = g.trashed.length, modified = g.modified.length;
    await t.poll();
    g.label(ids.drop, ["INBOX"]);   // the user restores the deleted receipt
    await t.poll();
    sq.prepare("UPDATE gmail_accounts SET poll_history_id = '5000' WHERE email = ?").run(E);   // the poll reads the whole history again
    await t.poll();
    check(g.trashed.length === trashed && g.modified.length === modified, `no message is decided twice: not on a quiet poll, not after a restore, not on a replayed history (${g.trashed.length - trashed} more trash, ${g.modified.length - modified} more moves)`);
    check(sq.prepare("SELECT COUNT(*) n FROM mention_decisions").get().n === 7, "one decision row per message a rule matched");
    // an address-level block still wins over a mention rule
    sq.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES ('b1', 'blocked@musicnews.example', 'block', '*', '2026-10-16')").run();
    const blk = g.put(["INBOX"], { from: "blocked@musicnews.example", subject: "SXSW news", plain: "SXSW" });
    await t.poll();
    check(g.trashed.includes(blk) && decision(blk) === null, "an address-level block still trashes, and no mention decision is made");
    // the daily report
    await mod.dailyReport(t.env, []);
    const text = String(t.sent.at(-1)?.text || t.sent.at(-1)?.content || JSON.stringify(t.sent.at(-1) || ""));
    check(/delete-unless-it-mentions rules: 6; last 24h kept 2, moved out of spam 1, deleted 2, kept unread 2, left 0$/m.test(text), `the daily report counts the decisions (${(text.match(/delete-unless[^\n]*/) || [""])[0]})`);
    check(/deleted sam\.owner\.sxsw@gmail\.com <- noreply@uber\.com \| Your Thursday trip/.test(text), "and lists each deleted mail");
  }
  // ---------- the audit's cases, end to end ----------
  {
    const t = await setup(); const { g, sq, api, decision } = t;
    for (const p of ["*@musicnews.example", "*@uber.com", "*@stubhub.com", "*@zine.example"]) await api("POST", "/api/mention-rules", { pattern: p, words: ["SXSW", "South by Southwest"], scope: E });
    sq.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES ('b2', '*@zine.example', 'block', '*', '2026-10-16')").run();
    const long = "Here is everything happening this weekend across the city, with listings and prices.";
    g.put(["SENT"], { from: E, subject: "Lost item", plain: "I left my jacket in the car", thread: "conv1" });
    const c = {
      pics: g.put(["INBOX"], { from: "news@musicnews.example", subject: "New", html: '<img src="cid:x"><p>View online</p>' }),
      split: g.put(["INBOX"], { from: "news@musicnews.example", subject: "Week", html: `<p>Our SX<b>SW</b> week. ${long}</p>` }),
      cal: g.put(["INBOX"], { from: "news@musicnews.example", subject: "Invitation", plain: long, cal: "BEGIN:VCALENDAR\nSUMMARY:SXSW panel\nEND:VCALENDAR" }),
      conv: g.put(["INBOX"], { from: "support@uber.com", subject: "Re: Lost item", plain: `We found it. ${long}`, thread: "conv1" }),
      archived: g.put(["INBOX"], { from: "noreply@uber.com", subject: "Receipt", plain: long }),
      lost: g.put(["INBOX"], { from: "noreply@uber.com", subject: "Receipt 2", plain: long }),
      refused: g.put(["INBOX"], { from: "noreply@uber.com", subject: "Receipt 3", plain: long }),
      unknown: g.put(["INBOX"], { from: "noreply@uber.com", subject: "Receipt 4", plain: long }),
      other: g.put(["INBOX"], { from: "noreply@uber.com", subject: "Receipt 5", plain: long }),
      blockedUnread: g.put(["INBOX"], { from: "hello@zine.example", subject: "Issue", plain: long }),
      blockedKept: g.put(["INBOX"], { from: "hello@zine.example", subject: "Issue 2", plain: `SXSW issue. ${long}` }),
      spamMoved: g.put(["SPAM"], { from: "promo@stubhub.com", subject: "Seats", plain: long, ar: "mx.google.com; spf=pass (google.com: domain of bounce@stubhub.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@stubhub.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=stubhub.com" }),
    };
    g.flipOnFull.set(c.archived, ["CATEGORY_UPDATES"]); g.flipOnFull.set(c.spamMoved, ["INBOX"]);
    g.trashFail.set(c.lost, "lost"); g.trashFail.set(c.refused, "refuse"); g.trashFail.set(c.unknown, "refuse"); g.failMinimal.add(c.unknown);
    g.failFull.add(c.blockedUnread);
    sq.prepare("INSERT INTO mention_decisions (account, id, rule_id, decision, from_addr, subject, at) VALUES (?, ?, 'x', 'claimed', 'noreply@uber.com', 'Receipt 5', ?)").run(E, c.other, new Date().toISOString());
    await t.poll("all");
    check(decision(c.pics) === "unread" && !g.trashed.includes(c.pics), `a picture-only mail is kept, as the record says (${decision(c.pics)}; 831aca9b68)`);
    check(decision(c.split) === "kept", `a word split by markup keeps the mail (${decision(c.split)}; c98d3935f6)`);
    check(decision(c.cal) === "kept", `a word in the invitation's calendar part keeps it (${decision(c.cal)}; 1ad87daa90)`);
    check(decision(c.conv) === "left" && !g.trashed.includes(c.conv) && g.threadGets > 0, `a reply in a conversation you wrote in is never deleted (${decision(c.conv)})`);
    check(decision(c.archived) === "left" && !g.trashed.includes(c.archived), `a mail you moved after it arrived is left where you put it (${decision(c.archived)}; 9420b1d817)`);
    check(decision(c.spamMoved) === "left" && !g.trashed.includes(c.spamMoved) && !g.modified.some((x) => x.id === c.spamMoved), `spam you moved to the inbox in that moment is left alone (${decision(c.spamMoved)}; 9420b1d817)`);
    check(decision(c.lost) === "dropped" && g.msgs.get(c.lost).labelIds.includes("TRASH"), `a trash whose answer was lost is recorded as deleted, from the labels (${decision(c.lost)}; 3579bbad5d)`);
    check(decision(c.refused) === "failed" && g.msgs.get(c.refused).labelIds.includes("INBOX"), `a trash Gmail refused is recorded as failed and the mail stays (${decision(c.refused)})`);
    check(decision(c.unknown) === "dropping", `a trash that cannot be confirmed either way stays "dropping" (${decision(c.unknown)}; 17937453dd)`);
    // Notified under "All": the seven that stayed in the inbox and were not handed to the block; not the claimed one, not the deleted ones.
    check(decision(c.other) === "claimed" && !g.trashed.includes(c.other) && /new=7 blocked=1 notified=7 /.test(t.notified()), `a mail another run claimed is left to it: not touched, not notified (${(t.notified().match(/new=\S+ blocked=\S+ notified=\S+/) || [""])[0]}; 5d58539d8d)`);
    check(decision(c.blockedUnread) === "unread" && g.trashed.includes(c.blockedUnread), `a domain block still applies to a mail the rule could not read (1a98124756)`);
    check(decision(c.blockedKept) === "kept" && !g.trashed.includes(c.blockedKept), "a domain block gives way to a mail kept for its words");
    await mod.dailyReport(t.env, []);
    const text = String(t.sent.at(-1)?.text || "");
    check(/maybe deleted <-- CHECK sam\.owner\.sxsw@gmail\.com <- noreply@uber\.com \| Receipt 4/.test(text) && /not finished 1 <-- CHECK/.test(text), `the report lists an unconfirmed deletion and says CHECK (${(text.match(/delete-unless[^\n]*/) || [""])[0]})`);
  }
  // ---------- at most MENTION_RUN_MAX decisions a run ----------
  {
    const t = await setup(); const { g, sq, api } = t;
    await api("POST", "/api/mention-rules", { pattern: "*@uber.com", words: ["SXSW"], scope: E });
    const many = Array.from({ length: 42 }, (_, i) => g.put(["INBOX"], { from: "noreply@uber.com", subject: "Receipt " + i, plain: "Thanks for riding with us today, here is your receipt and trip map." }));
    await t.poll("all");
    const decided = sq.prepare("SELECT COUNT(*) n FROM mention_decisions").get().n, capped = sq.prepare("SELECT detail FROM events WHERE kind = 'mention_capped'").get()?.detail || "";
    check(decided === 40 && g.trashed.length === 40 && /2 message\(s\) past this run's 40 decisions/.test(capped) && many.slice(-2).every((id) => g.msgs.get(id).labelIds.includes("INBOX")), `a run decides at most 40; the rest are left as they arrived and logged (${decided} decided, ${g.trashed.length} trashed; 9ec3fd1972)`);
  }
  // ---------- the API refuses ----------
  {
    const t = await setup(); const { api } = t;
    const bad = async (body, why) => { const r = await api("POST", "/api/mention-rules", body); check(r.status === 400, `refused: ${why} (${r.status} ${r.body?.error || ""})`); };
    await bad({ pattern: "*@gmail.com", words: ["SXSW"] }, "a public mailbox domain");
    await bad({ pattern: "*@co.uk", words: ["SXSW"] }, "a public suffix");
    for (const d of ["co.jp", "com.au", "co.kr", "com.br"]) await bad({ pattern: "*@" + d, words: ["SXSW"] }, `${d}, which the audit said would pass (ba060bfce1)`);
    await bad({ pattern: "uber", words: ["SXSW"] }, "not an address");
    await bad({ pattern: "*@uber.com", words: [] }, "no words");
    await bad({ pattern: "*@uber.com", words: ["x"] }, "a one-letter word");
    await bad({ pattern: "*@uber.com", words: ["SXSW"], scope: "someone@else.com" }, "a scope that is not a connected Gmail account");
    const ok = await api("POST", "/api/mention-rules", { pattern: "*@uber.com", words: ["SXSW"] });
    const list = await api("GET", "/api/mention-rules");
    const del = await api("DELETE", "/api/mention-rules/" + ok.body?.rule?.id);
    check(ok.status === 200 && list.body?.rules?.length === 1 && del.body?.removed === 1 && (await api("GET", "/api/mention-rules")).body?.rules?.length === 0, "a rule can be listed and removed");
    // notifications set to "None": a kept mail is kept, and notifies nothing
    await api("POST", "/api/mention-rules", { pattern: "*@uber.com", words: ["SXSW"] });
    const k = t.g.put(["INBOX"], { from: "noreply@uber.com", subject: "Rides to SXSW", plain: "Book your SXSW ride" });
    await t.poll("none");
    check(t.decision(k) === "kept" && !/notified=/.test(t.notified()), `with notifications off, a kept mail is kept and silent (${t.decision(k)})`);
  }
  // ---------- trash rules on the Gmail poll ----------
  // The user's rule on the sender's name and/or the subject decides before Block and the mention rules: to Gmail's Trash, no notification.
  {
    const t = await setup(); const { g, sq, api } = t;
    const r1 = await api("POST", "/api/trash-rules", { name: "Webmail", scope: E });
    const r2 = await api("POST", "/api/trash-rules", { subject: "Certificate needed ASAP", scope: "*" });
    await api("POST", "/api/trash-rules", { name: "Webmail", scope: "someone@else.com" });   // another account: never this one
    await api("POST", "/api/mention-rules", { pattern: "*@musicnews.example", words: ["SXSW"], scope: E });
    const c = {
      phish: g.put(["INBOX"], { from: "Webmail <support@phish.example>", subject: "Please review your encrypted messages", plain: "Action required" }),
      phish2: g.put(["INBOX"], { from: "\"WebMail Admin\" <ldap@thaiplace.example>", subject: "Quarantined messages", plain: "x" }),
      subj: g.put(["INBOX"], { from: "Helpdesk <it@nowhere.example>", subject: "IT-1253 Certificate Needed ASAP", plain: "x" }),
      bare: g.put(["INBOX"], { from: "webmail@realhost.example", subject: "Hello", plain: "x" }),
      longer: g.put(["INBOX"], { from: "Webmailer <x@y.example>", subject: "Hi", plain: "x" }),
      friend: g.put(["INBOX"], { from: "Grace <grace@example.com>", subject: "Lunch?", plain: "Tuesday?" }),
      mention: g.put(["INBOX"], { from: "Webmail <news@musicnews.example>", subject: "SXSW lineup", plain: "SXSW" }),
    };
    await t.poll();
    check(r1.status === 200 && r1.body?.rule?.name === "webmail" && r2.body?.rule?.subject === "certificate needed asap", `rules are stored as lowercase words (${JSON.stringify([r1.body?.rule?.name, r2.body?.rule?.subject])})`);
    for (const k of ["phish", "phish2", "subj", "mention"]) check(g.trashed.includes(c[k]), `trashed by a rule: ${k}`);
    for (const k of ["bare", "longer", "friend"]) check(!g.trashed.includes(c[k]), `left alone: ${k} (a bare address has no name; "Webmailer" is another word)`);
    check(t.decision(c.mention) === null, "a trash rule decides before a mention rule, which never reads the mail");
    check(/new=3 blocked=0 notified=3 /.test(t.notified()), `only the three left alone notify (${(t.notified().match(/new=\S+ blocked=\S+ notified=\S+/g) || []).at(-1)})`);
    const hits = sq.prepare("SELECT name, subject, hits FROM trash_rules ORDER BY name").all();
    check(hits.some((h) => h.name === "webmail" && h.hits === 3) && hits.some((h) => h.name === "webmail" && h.hits === 0) && hits.find((h) => h.subject === "certificate needed asap")?.hits === 1, `each rule counts what it trashed, and another account's rule nothing (${JSON.stringify(hits)})`);
    check(sq.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'rule_trashed'").get().n === 4, "and each is in the events table");
    // Gmail refuses the trash: the mail is handled as usual, not lost from sight
    const refused = g.put(["INBOX"], { from: "Webmail <a@b.example>", subject: "One more", plain: "x" }); g.trashFail.set(refused, "refuse");
    await t.poll();
    check(!g.trashed.includes(refused) && /notified=1 /.test(t.notified().split("\n").at(-1)) && sq.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'rule_trash_fail'").get().n === 1, `a refused trash is logged and the mail notifies as usual (${t.notified().split("\n").at(-1)})`);
  }
} catch (e) { check(false, "threw: " + (e?.stack || e).toString().split("\n").slice(0, 3).join(" | ")); }
finally { globalThis.fetch = realFetch; }
console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall mention-rule checks passed");
process.exit(fails.length ? 1 : 0);
