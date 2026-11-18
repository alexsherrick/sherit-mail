#!/usr/bin/env node
// Trash rules on the Cloudflare path, and the API. The real email() handler, real migrations on real SQLite, a fake R2.
// The user's case: the "Webmail" phish reached sam@domain5.example from three domains in a month under the one sender name.
//  - the API: words stored lowercase, a rule needs a name or a subject and a scope, listed, removed;
//  - the matcher: every word in any order, whole words, both fields when both are set, an address / a domain / every account;
//  - arrival: matching mail is stored in Trash on a conversation of its own, read, labelled, never announced and its images never
//  fetched; a reply into a wanted conversation does not trash or revive it; mail out of scope arrives as usual; rules that cannot be
//  read file the mail as before; a removed rule stops.
// Usage: node test/trashrules.mjs (exit 1 on any failed check)
// CONTROL: TRASH_SRC=<an index.js from before the change> node test/trashrules.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} }
const state = { rulesDown: false };
const d1 = { prepare(sql) { const run = (p, kind) => { if (state.rulesDown && /FROM trash_rules/i.test(sql)) throw new Error("D1_UNAVAILABLE"); const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
    const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a), all: async () => run(p, "all"), first: async () => run(p, "first"), run: async () => run(p, "run") }); return mk([]); },
  batch: async (xs) => { sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } };
const objs = new Map();
const STORE = { put: async (k, v, o) => { objs.set(k, { body: Buffer.from(typeof v === "string" ? v : new Uint8Array(v)), customMetadata: (o || {}).customMetadata || {} }); return {}; }, get: async (k) => { const o = objs.get(k); return o ? { body: o.body, arrayBuffer: async () => o.body, customMetadata: o.customMetadata, httpMetadata: {} } : null; }, delete: async (k) => { objs.delete(k); }, head: async (k) => (objs.has(k) ? {} : null), list: async () => ({ objects: [], truncated: false }) };
const fetched = [];
globalThis.fetch = async (u) => { fetched.push(String(u)); return new Response("{}", { status: 200 }); };   // images, DNS, push: recorded, never sent
const SRC = readFileSync(process.env.TRASH_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = HUB + "test/_trashrules_mod.mjs"; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));
const env = { DB: d1, STORE, FORWARD_TO: "x@gmail.com", DOMAINS: "domain5.example,domain2.example", CLI_TOKEN: "test-token", SESSION_SECRET: "s", EMAIL: { send: async () => ({}) } };
let waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const settle = async () => { for (let i = 0; i < 5; i++) { const w = waits; waits = []; await Promise.allSettled(w); await new Promise((r) => setTimeout(r, 10)); } };
const api = async (method, path, body) => { const r = await mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; };
let n = 0;
const mail = async ({ from, to = "sam@domain5.example", subject = "Hello", irt = null }) => {
  n++; const id = `tr-${n}@example.com`, envFrom = from.replace(/^.*<|>$/g, "");
  const raw = [`From: ${from}`, `To: <${to}>`, `Subject: ${subject}`, `Message-ID: <${id}>`, ...(irt ? [`In-Reply-To: <${irt}>`] : []), `Date: Wed, 21 Oct 2026 20:${String(n).padStart(2, "0")}:00 +0000`,
    `Content-Type: text/html; charset=utf-8`, ``, `<p>Action required</p><img src="https://track${n}.example/p.gif" width="600" height="200">`, ``].join("\r\n");
  const f0 = fetched.length, feed0 = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get().n;
  await mod.default.email({ to, from: envFrom, rawSize: raw.length, raw, headers: new Headers({ subject, "message-id": `<${id}>`, from, date: "Wed, 21 Oct 2026 20:00:00 +0000" }), forward: async () => {}, setReject: () => {} }, env, ctx);
  await settle();
  const row = sq.prepare("SELECT m.id, m.thread_id, t.state, t.unread, t.labels, t.message_count FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = ?").get(`<${id}>`) || {};
  return { ...row, msgid: id, images: fetched.slice(f0).some((u) => u.includes(`track${n}.example`)), announced: sq.prepare("SELECT COUNT(*) n FROM notify_feed").get().n - feed0 };
};

try {
  // ---------- the API ----------
  const bad = async (body, why) => { const r = await api("POST", "/api/trash-rules", body); check(r.status === 400, `refused: ${why} (${r.status} ${r.body?.error || ""})`); };
  await bad({ scope: "*" }, "no name and no subject");
  await bad({ name: "  ", subject: "!!", scope: "*" }, "only spaces and punctuation");
  await bad({ name: "Webmail", scope: "letters" }, "a scope that is not an address, *@domain or *");
  await bad({ name: "Webmail" }, "no scope");
  const r1 = await api("POST", "/api/trash-rules", { name: "  Webmail ", scope: "*@domain5.example" });
  check(r1.status === 200 && r1.body?.rule?.name === "webmail" && r1.body?.rule?.subject === "" && r1.body?.rule?.scope === "*@domain5.example", `a rule is stored as lowercase words and scope (${JSON.stringify(r1.body?.rule)})`);
  const again = await api("POST", "/api/trash-rules", { name: "WEBMAIL", scope: "*@domain5.example" });
  check(again.body?.rule?.id === r1.body?.rule?.id && sq.prepare("SELECT COUNT(*) n FROM trash_rules").get().n === 1, "the same rule twice is one rule");

  // ---------- the matcher ----------
  if (typeof mod.trashMatch === "function") {
    const R = [{ id: "a", scope: "sam@domain5.example", name: "webmail", subject: "" }, { id: "b", scope: "*", name: "support helpdesk", subject: "certificate needed" }, { id: "c", scope: "*@corp.example", name: "", subject: "do not share" }];
    const m = (name, subject, account) => mod.trashMatch(R, { name, subject, account })?.id || null;
    check(m("Webmail", "x", "sam@domain5.example") === "a" && m("WebMail Admin", "x", "sam@domain5.example") === "a", "a name holding the word, in any case, matches");
    check(m("Webmailer", "x", "sam@domain5.example") === null && m("Webmail", "x", "bob@domain5.example") === null, "another word, or another address, does not");
    check(m("Helpdesk Support", "IT-1253 Certificate Needed ASAP", "z@gmail.com") === "b" && m("Support Helpdesk", "Your ticket", "z@gmail.com") === null, "both fields must match when both are set, words in any order");
    check(m("Uber", "Do not share: 3651", "kim@corp.example") === "c" && m("Uber", "Do not share: 3651", "kim@corp.example.net") === null, "a domain scope covers its addresses, not a look-alike");
  } else check(false, "trashMatch is exported");

  // ---------- arrival on the Cloudflare path ----------
  const friend = await mail({ from: "Grace <grace@example.com>", subject: "Plan for Tuesday" });
  check(friend.state === "inbox" && friend.images && friend.announced === 1, `ordinary mail arrives, is announced, and its images are fetched (${friend.state}, images ${friend.images}, announced ${friend.announced})`);
  const phish = await mail({ from: "Webmail <support@phish.example>", subject: "Please review your encrypted messages" });
  check(phish.state === "trash" && /trash-rule/.test(phish.labels || "") && phish.unread === 0, `the Webmail mail is stored in Trash, labelled, read (${phish.state}, ${phish.labels}, unread ${phish.unread})`);
  check(phish.announced === 0 && !phish.images, `it is not announced and its images are never fetched (announced ${phish.announced}, images ${phish.images})`);
  check(sq.prepare("SELECT hits FROM trash_rules").get().hits === 1 && sq.prepare("SELECT message_id FROM events WHERE kind = 'rule_trashed'").get()?.message_id === phish.id, "the rule counts it, and the event names the message");
  const phish2 = await mail({ from: '"WebMail Support" <ldap@thaiplace.example>', to: "anything@domain5.example", subject: "Please review your quarantined messages" });
  check(phish2.state === "trash", `the next one, from another domain to another domain5.example address, too (${phish2.state})`);
  const elsewhere = await mail({ from: "Webmail <support@phish.example>", to: "sam@domain2.example", subject: "Please review your encrypted messages" });
  check(elsewhere.state === "inbox" && elsewhere.announced === 1, `the same mail to domain2.example, outside the rule, arrives as usual (${elsewhere.state})`);
  // a reply into a wanted conversation: the rule files it apart, and the conversation is neither trashed nor revived nor counted
  const reply = await mail({ from: "Webmail <grace@example.com>", subject: "Re: Plan for Tuesday", irt: friend.msgid });
  const conv = sq.prepare("SELECT state, message_count FROM threads WHERE id = ?").get(friend.thread_id);
  check(reply.state === "trash" && reply.thread_id !== friend.thread_id && conv.state === "inbox" && conv.message_count === 1, `a matching reply gets its own conversation in Trash; the wanted one stays as it was (${reply.state}, same thread ${reply.thread_id === friend.thread_id}, ${conv.state}/${conv.message_count})`);
  // both fields
  await api("POST", "/api/trash-rules", { name: "Support Helpdesk", subject: "Certificate Needed", scope: "*" });
  const half = await mail({ from: "Support Helpdesk <jira@corp.atlassian.net>", to: "sam@domain2.example", subject: "IT-1255 Daily report for the ops team" });
  const both = await mail({ from: "Support Helpdesk <jira@corp.atlassian.net>", to: "sam@domain2.example", subject: "IT-1253 Certificate Needed ASAP" });
  check(half.state === "inbox" && both.state === "trash", `with a name and a subject, only mail matching both is trashed (${half.state}, ${both.state})`);
  // rules that cannot be read: the mail is filed as before
  state.rulesDown = true;
  const down = await mail({ from: "Webmail <x@down.example>", subject: "Please review" });
  state.rulesDown = false;
  check(down.state === "inbox" && down.announced === 1, `with the rules unreadable, the mail arrives as usual (${down.state})`);
  // listed, removed, and then it stops
  const list = await api("GET", "/api/trash-rules");
  const del = await api("DELETE", "/api/trash-rules/" + r1.body?.rule?.id);
  check(list.body?.rules?.length === 2 && del.body?.removed === 1 && sq.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'trash_rule_removed'").get().n === 1, "rules are listed and removed one by one");
  const after = await mail({ from: "Webmail <support@phish.example>", subject: "Please review your encrypted messages" });
  check(after.state === "inbox", `with the rule removed, that mail arrives again (${after.state})`);
} catch (e) { check(false, "threw: " + (e?.stack || e).toString().split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall trash-rule checks passed");
process.exit(fails.length ? 1 : 0);
