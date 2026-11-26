#!/usr/bin/env node
// Impostors: mail named after a company the user gets mail from, sent from a domain that has never written. 2026-11-23
// to -25, three fakes under one company's name, each from noreply@ an unrelated domain through that domain's own SendGrid account, so every
// sender check passed, reached the main Gmail inbox; the real brand-table check (trust.js) knew only invitation brands and said nothing.
// The real Worker's Gmail poll and mirror and its email() handler, real migrations on real SQLite, a fake Gmail and a fake R2.
//  - the hub's copy and the app's copy of the check are the same text, and the two domain readers agree;
//  - the check: a company's name with plain words after it, from a new domain that does not carry the name; not a person whose first
//  name is a company, not the company's own mail service, not a domain that has written before;
//  - Gmail: an impostor goes to Spam, unannounced, its sender unrecorded, so the next one from that domain goes too; genuine mail from
//  the company, from its mail service, and from a service that has written before arrives as usual; Gmail refusing the move leaves
//  the mail as usual;
//  - mail to the user's own domains: filed in Spam on a conversation of its own, labelled, unannounced, its pictures not fetched;
//  - GET /api/senders/orgs: signed in only; the domains that have written and the user's own, not a blocked sender's;
//  - the app's banner: "Named …, but it wasn't sent by …", and nothing without the hub's list.
// Usage: node test/impostor.mjs (exit 1 on any failed check)
// CONTROL: IMPOSTOR_SRC=<an index.js from before the change> node test/impostor.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import vm from "node:vm";

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
const INDEX = readFileSync(process.env.IMPOSTOR_SRC || HUB + "src/index.js", "utf8"), TRUST = readFileSync(HUB + "src/client/trust.js", "utf8");
const SRC = INDEX
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";')
  + (/\bfunction impostorOf\(/.test(INDEX) ? "\nexport { impostorOf, impostorKnownOf };\n" : "");
const tmp = `${HUB}src/_impostor_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

// ---------- 1. one check, in two places ----------
const block = (s) => { const a = s.indexOf("const IMPOSTOR_PLAIN = new Set("), b = s.indexOf("\n  return { orgs, byLabel };\n}\n", a); return a < 0 || b < 0 ? null : s.slice(a, b); };
check(block(INDEX) !== null && block(INDEX) === block(TRUST), `the hub's impostor check and the app's are the same text (${block(INDEX) ? block(INDEX).length : 0} and ${block(TRUST) ? block(TRUST).length : 0} characters)`);
const suffixes = (s, name) => { const m = new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`).exec(s); return m ? JSON.stringify(JSON.parse(m[1]).sort()) : "none"; };
check(suffixes(INDEX, "LOCK_SUFFIX2") === suffixes(TRUST, "TRUST_SUFFIX2") && /const impostorRoot = lockRoot;/.test(INDEX) && /const impostorRoot = trustRoot;/.test(TRUST), "and both read a domain the same way (lockRoot and trustRoot, one list of two-part endings)");

// ---------- 2. the check ----------
const known = (orgs) => (typeof mod.impostorKnownOf === "function" ? mod.impostorKnownOf(orgs) : null);
const K = known(["northwind.example", "blueharbor.example", "esp.example", "shopmail.example", "hub.example"]);
const imp = (name, addr) => (typeof mod.impostorOf === "function" ? mod.impostorOf(name, addr, K) : undefined);
const v1 = imp("Northwind", "noreply@otherco.example");
check(v1 && v1.name === "Northwind" && v1.real === "northwind.example" && v1.org === "otherco.example", `"Northwind" from a new domain is an impostor, naming where Northwind's mail comes from (${JSON.stringify(v1)})`);
check(!!imp("Northwind Alerts", "alerts@phish.example") && !!imp("The Northwind Team", "x@phish.example") && imp("Blue Harbor", "online@postmaster.example")?.real === "blueharbor.example", "with plain words after it, with \"The\" before it, and a two-word name run together");
check(imp("Northwind Fitness", "noreply@phish.example") === null && imp("Northwind Smith", "ns@freemail.example") === null, "a name with a word of its own after the company's is not (a product, or a person named for it)");
check(imp("Northwind", "northwind@mail.sailthru.example") === null && imp("Northwind", "noreply@northwind-mail.example") === null && imp("Northwind Support", "support@northwindsupport.freshdesk.example") === null, "an address carrying the name is the company's own mail service");
check(imp("Northwind", "noreply@esp.example") === null && imp("Northwind", "news@northwind.example") === null && imp("Northwind", "news@mail.northwind.example") === null, "a domain that has written before is not, nor the company's own");
check(imp("Sam", "sam@freemail.example") === null && imp("", "noreply@phish.example") === null && imp("NW", "noreply@phish.example") === null, "a name that is no company's, no name, or under three letters is not");

// ---------- 3. Gmail ----------
const NOW = Date.now(); let seq = 0; const gid = () => Math.floor(NOW).toString(16) + (++seq).toString(16).padStart(5, "0");
const E = "sam.owner@gmail.com";
class Gmail {
  constructor() { this.msgs = new Map(); this.hist = []; this.hid = 5000; this.modified = []; this.refuseModify = false; }
  rec(r) { this.hid += 3; this.hist.push({ id: String(this.hid), ...r }); return this.hid; }
  put(labels, { from, subject }) {
    const id = gid(), threadId = "t" + id;
    this.msgs.set(id, { id, threadId, labelIds: labels, internalDate: String(NOW), snippet: "", subject, from });
    this.msgs.get(id).hid = this.rec({ messagesAdded: [{ message: { id, threadId, labelIds: labels } }] });
    return { id, threadId };
  }
  resource(m) { return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.snippet, historyId: String(m.hid), sizeEstimate: 100, payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "To", value: E }] } }; }
  async fetch(url, o = {}) {
    const u = String(url), json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    if (u === "https://gmail.googleapis.com/batch/gmail/v1") {
      const ids = [...String(o.body).matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)\?/g)].map((x) => x[1]), B = "batch_resp_x";
      const body = ids.map((id, k) => { const m = this.msgs.get(id); return `--${B}\r\nContent-Type: application/http\r\nContent-ID: <response-i${k}>\r\n\r\n` + (m ? `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.resource(m))}\r\n` : `HTTP/1.1 404 Not Found\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"error":{"code":404}}\r\n`); }).join("") + `--${B}--`;
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
    if ((x = path.match(/^messages\/([^/?]+)\/modify$/)) && o.method === "POST") {
      if (this.refuseModify) return json({ error: { code: 500, message: "backend error" } }, 500);
      const m = this.msgs.get(x[1]), b = JSON.parse(o.body || "{}"); this.modified.push({ id: x[1], ...b });
      if (m) { m.labelIds = [...new Set([...m.labelIds.filter((l) => !(b.removeLabelIds || []).includes(l)), ...(b.addLabelIds || [])])]; this.rec({ labelsAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds }, labelIds: b.addLabelIds || [] }] }); }
      return json(m ? { id: m.id, labelIds: m.labelIds } : { error: { code: 404 } }, m ? 200 : 404);
    }
    if ((x = path.match(/^messages\/([^/?]+)\?format=metadata/))) { const m = this.msgs.get(x[1]); return m ? json(this.resource(m)) : json({ error: { code: 404 } }, 404); }
    if ((x = path.match(/^messages\/([^/?]+)\?format=minimal$/))) { const m = this.msgs.get(x[1]); return m ? json({ id: m.id, labelIds: m.labelIds }) : json({ error: { code: 404 } }, 404); }
    if ((x = path.match(/^messages\/([^/?]+)\?format=full$/))) { const m = this.msgs.get(x[1]); return m ? json(this.resource(m)) : json({ error: { code: 404 } }, 404); }
    if ((x = path.match(/^threads\/([^/?]+)\?format=minimal$/))) return json({ id: x[1], messages: [...this.msgs.values()].filter((m) => m.threadId === x[1]).map((m) => ({ id: m.id, labelIds: m.labelIds })) });
    return json({ error: "unmocked " + u }, 404);
  }
}
const g = new Gmail(), realFetch = globalThis.fetch;
const objs = new Map();
const STORE = { put: async (k, v, o) => { objs.set(k, { body: Buffer.from(typeof v === "string" ? v : new Uint8Array(v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer())), customMetadata: (o || {}).customMetadata || {} }); return {}; }, get: async (k) => { const o = objs.get(k); return o ? { body: new Response(o.body).body, arrayBuffer: async () => o.body, text: async () => o.body.toString(), customMetadata: o.customMetadata, httpMetadata: {} } : null; }, head: async (k) => (objs.has(k) ? { key: k } : null), delete: async () => {}, list: async () => ({ objects: [], truncated: false }) };
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const env = { DB: db, STORE, GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", FORWARD_TO: "me@gmail.com", DOMAINS: "hub.example", CLI_TOKEN: "t", SESSION_SECRET: "s", EMAIL: { send: async () => {} } };
const sealed = await mod.sealToken(env, "refresh-token", E);
sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, label) VALUES (?, ?, ?, 's', 'active', '2026-10-07', 'Mine')").run(E, sealed.enc, sealed.iv);
// the user's known senders: Northwind writes from its own domain, and a mail service has sent for others before; one sender is blocked
const ks = sq.prepare("INSERT INTO known_senders (address, status, first_seen_at, last_seen_at, first_account, seen_count) VALUES (?, ?, '2026-11-01', '2026-11-01', ?, 3)");
for (const [a, st] of [["membership@m.northwind.example", "accepted"], ["noreply@esp.example", "pending"], ["online@blueharbor.example", "accepted"], ["spam@blocked.example", "blocked"]]) ks.run(a, st, E);
const fetched = [];
globalThis.fetch = (u, o) => { const s = String(typeof u === "string" ? u : u.url); if (/gmail\.googleapis\.com|oauth2\.googleapis\.com/.test(s)) return g.fetch(s, o); fetched.push(s); return Promise.resolve(new Response("{}", { status: 200 })); };
const feed = () => sq.prepare("SELECT payload FROM notify_feed ORDER BY seq").all().map((r) => JSON.parse(r.payload));
const ev = (kind) => sq.prepare("SELECT detail, message_id FROM events WHERE kind = ? ORDER BY id").all(kind);
const sender = (a) => sq.prepare("SELECT status FROM known_senders WHERE address = ?").get(a)?.status || null;
try {
  g.put(["INBOX"], { from: '"Northwind" <membership@m.northwind.example>', subject: "Your renewal" });
  for (let i = 0; i < 20 && sq.prepare("SELECT mirror_state FROM gmail_accounts WHERE email = ?").get(E)?.mirror_state !== "ready"; i++) await mod.gmailMirrorOnce(env, E);
  const poll = async () => { await mod.gmailMirrorOnce(env, E).catch(() => {}); return mod.gmailPollAccount(env, { email: E }, async () => sq.prepare("SELECT pattern, action, scope, category FROM sender_rules").all(), "all"); };
  await poll();
  const n0 = feed().length;
  const fake = g.put(["UNREAD", "CATEGORY_PERSONAL", "INBOX"], { from: '"Northwind" <noreply@otherco.example>', subject: "New Login Detected" });
  await poll();
  const mv = g.modified.find((x) => x.id === fake.id);
  check(mv && JSON.stringify(mv.addLabelIds) === '["SPAM"]' && JSON.stringify(mv.removeLabelIds) === '["INBOX"]', `Gmail: the impostor is moved to Spam (${JSON.stringify(mv)})`);
  check(feed().length === n0 && sender("noreply@otherco.example") === null, `unannounced, and its sender is not recorded (${feed().length - n0} pushes, sender ${sender("noreply@otherco.example")})`);
  const e1 = ev("impostor_spam");
  check(e1.length === 1 && e1[0].detail.includes(fake.id) && /named "Northwind", whose mail comes from northwind\.example; this came from otherco\.example/.test(e1[0].detail), `an impostor_spam event says why (${e1.map((x) => x.detail).join(" | ")})`);
  const fake2 = g.put(["UNREAD", "INBOX"], { from: '"Northwind" <noreply@otherco.example>', subject: "Join Northwind Gold" });
  await poll();
  check(g.modified.some((x) => x.id === fake2.id) && feed().length === n0, "the next one from the same domain goes too");
  const genuine = [
    g.put(["UNREAD", "INBOX"], { from: '"Northwind" <membership@m.northwind.example>', subject: "Your class tomorrow" }),
    g.put(["UNREAD", "INBOX"], { from: '"Northwind" <northwind@mail.sailthru.example>', subject: "Auction tonight" }),
    g.put(["UNREAD", "INBOX"], { from: '"Northwind" <noreply@esp.example>', subject: "Tickets for $30" }),
    g.put(["UNREAD", "INBOX"], { from: '"Northwind Smith" <ns@freemail.example>', subject: "Lunch?" }),
  ];
  await poll();
  check(genuine.every((m) => !g.modified.some((x) => x.id === m.id)) && feed().length === n0 + 4, `genuine mail arrives as usual: the company's own, its mail service's, a service that has written before, a person (${feed().length - n0} of 4 announced, ${genuine.filter((m) => g.modified.some((x) => x.id === m.id)).length} moved)`);
  g.refuseModify = true;
  const refused = g.put(["UNREAD", "INBOX"], { from: '"Blue Harbor" <online@refused.example>', subject: "A purchase was charged" });
  await poll(); g.refuseModify = false;
  check(feed().length === n0 + 5 && ev("impostor_spam_fail").some((x) => x.detail.includes(refused.id)), `if Gmail refuses the move, the mail is handled as usual and the refusal logged (${feed().length - n0 - 4} announced)`);

  // ---------- 4. mail to the user's own domains ----------
  let waits = []; const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
  const settle = async () => { for (let i = 0; i < 5; i++) { const w = waits; waits = []; await Promise.allSettled(w); await new Promise((r) => setTimeout(r, 10)); } };
  let n = 0;
  const mail = async ({ from, to = "hello@hub.example", subject = "Hello" }) => {
    n++; const id = `imp-${n}@example.com`, envFrom = from.replace(/^.*<|>$/g, "");
    const raw = [`From: ${from}`, `To: <${to}>`, `Subject: ${subject}`, `Message-ID: <${id}>`, `Date: Wed, 25 Nov 2026 20:${String(n).padStart(2, "0")}:00 +0000`, `Content-Type: text/html; charset=utf-8`, ``, `<p>Hi</p><img src="https://pics${n}.example/p.png" width="600" height="200">`, ``].join("\r\n");
    const f0 = fetched.length, feed0 = feed().length;
    await mod.default.email({ to, from: envFrom, rawSize: raw.length, raw, headers: new Headers({ subject, "message-id": `<${id}>`, from, date: "Wed, 25 Nov 2026 20:00:00 +0000" }), forward: async () => {}, setReject: () => {} }, env, ctx);
    await settle();
    const row = sq.prepare("SELECT m.id, m.thread_id, t.state, t.unread, t.labels FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = ?").get(`<${id}>`) || {};
    return { ...row, images: fetched.slice(f0).some((u) => u.includes(`pics${n}.example`)), announced: feed().length - feed0 };
  };
  const friend = await mail({ from: "A Friend <friend@else.example>", subject: "Plan for Tuesday" });
  check(friend.state === "inbox" && friend.announced === 1, `own domains: ordinary mail arrives and is announced (${friend.state}, ${friend.announced})`);
  const hubFake = await mail({ from: "Blue Harbor <online@postmaster.example>", subject: "A purchase was charged to your account" });
  check(hubFake.state === "spam" && /impostor/.test(hubFake.labels || "") && hubFake.announced === 0 && !hubFake.images, `an impostor is filed in Spam, labelled, unannounced, its pictures not fetched (${hubFake.state}, ${hubFake.labels}, announced ${hubFake.announced}, images ${hubFake.images})`);
  check(sender("online@postmaster.example") === null && ev("impostor_spam").some((x) => x.message_id === hubFake.id && /named "Blue Harbor", whose mail comes from blueharbor\.example/.test(x.detail)), "its sender is not recorded, and the event names the message");

  // ---------- 5. the domains that have written, for the app ----------
  const orgsOf = async (headers) => { const r = await mod.default.fetch(new Request("https://hub.example/api/senders/orgs", { headers }), env, ctx); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const no = await orgsOf({}), yes = await orgsOf({ Authorization: "Bearer t" });
  const orgs = yes.body.orgs || [];
  check(no.status === 401 && yes.status === 200 && ["northwind.example", "esp.example", "hub.example", "else.example"].every((o) => orgs.includes(o)), `GET /api/senders/orgs: signed in only; the domains that have written and the user's own (${no.status}, ${yes.status}, ${orgs.join(" ")})`);
  check(!orgs.includes("blocked.example") && !orgs.includes("otherco.example") && !orgs.includes("postmaster.example"), "not a blocked sender's, and not an impostor's");
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
finally { globalThis.fetch = realFetch; }

// ---------- 6. the app's banner ----------
const app = {}; vm.createContext(app); vm.runInContext(TRUST + "\n;globalThis.assessTrust = assessTrust; globalThis.impostorKnownOf = typeof impostorKnownOf === 'function' ? impostorKnownOf : null;", app);
const AK = app.impostorKnownOf ? app.impostorKnownOf(["northwind.example", "hub.example"]) : null;
const b = app.assessTrust({ fromAddr: "noreply@otherco.example", fromName: "Northwind", known: AK, subject: "New Login Detected", text: "A new sign-in to your Northwind account." });
check(b?.level === "danger" && b.title === "Named Northwind, but it wasn't sent by Northwind." && b.lines.some((l) => /northwind\.example/.test(l)) && b.ageDomain === "otherco.example", `the app: "${b?.title}" — ${(b?.lines || []).join(" ")}`);
check(app.assessTrust({ fromAddr: "noreply@otherco.example", fromName: "Northwind", subject: "x", text: "x" }) === null && app.assessTrust({ fromAddr: "membership@m.northwind.example", fromName: "Northwind", known: AK, subject: "x", text: "x" }) === null, "and nothing without the hub's list, or for the company's own mail");

console.log(fails.length ? `\n${fails.length} failed` : "\nall impostor checks passed");
process.exit(fails.length ? 1 : 0);
