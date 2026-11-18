#!/usr/bin/env node
// "Delete unless it mentions…" on mail at your own domains. The real email() handler, real migrations on real SQLite,
// a fake R2. A rule scoped "hub" covers mail outside Gmail:
//  - the API takes the scope "hub" and refuses one that is not *, hub or a connected Gmail account;
//  - arrival: no word, read in full, with text of its own: stored in Trash on a conversation of its own, labelled, never announced and
//  its pictures never fetched, the rule counting it; a word anywhere keeps it and it is announced; almost no text keeps it; a reply
//  in a conversation you wrote in is left; another sender, a Gmail-scoped rule and rules that cannot be read change nothing;
//  - the check of mail already here reads stored conversations: a word keeps, none drops, one you wrote in is yours, text cut at the
//  store's cap is unsure, an id that is not the hub's is skipped.
// Usage: node test/mentionhub.mjs (exit 1 on any failed check)
// CONTROL: MENTION_SRC=<an index.js from before the change> node test/mentionhub.mjs must fail.
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
const d1 = { prepare(sql) { const run = (p, kind) => { if (state.rulesDown && /FROM mention_rules/i.test(sql)) throw new Error("D1_UNAVAILABLE"); const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
    const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a), all: async () => run(p, "all"), first: async () => run(p, "first"), run: async () => run(p, "run") }); return mk([]); },
  batch: async (xs) => { sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } };
const objs = new Map();
const STORE = { put: async (k, v, o) => { objs.set(k, { body: Buffer.from(typeof v === "string" ? v : new Uint8Array(v)), customMetadata: (o || {}).customMetadata || {} }); return {}; }, get: async (k) => { const o = objs.get(k); return o ? { body: o.body, arrayBuffer: async () => o.body, customMetadata: o.customMetadata, httpMetadata: {} } : null; }, delete: async (k) => { objs.delete(k); }, head: async (k) => (objs.has(k) ? {} : null), list: async () => ({ objects: [], truncated: false }) };
const fetched = [];
globalThis.fetch = async (u) => { fetched.push(String(u)); return new Response("{}", { status: 200 }); };   // images, DNS, push: recorded, never sent
const SRC = readFileSync(process.env.MENTION_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = HUB + "test/_mentionhub_mod.mjs"; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));
const env = { DB: d1, STORE, FORWARD_TO: "x@gmail.com", DOMAINS: "domain5.example,domain2.example", CLI_TOKEN: "test-token", SESSION_SECRET: "s", EMAIL: { send: async () => ({}) } };
let waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const settle = async () => { for (let i = 0; i < 5; i++) { const w = waits; waits = []; await Promise.allSettled(w); await new Promise((r) => setTimeout(r, 10)); } };
const api = async (method, path, body) => { const r = await mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; };

const LONG = " Doors at seven, the bar opens at six, and the patio stays open late for everyone who comes along.";
let n = 0;
const mail = async ({ from = "Lakeside House <hello@lakeside.example>", to = "sam@domain5.example", subject = "Hello", html = "<p>Hello." + LONG + "</p>", irt = null }) => {
  n++; const id = `mh-${n}@example.com`, envFrom = from.replace(/^.*<|>$/g, "");
  const raw = [`From: ${from}`, `To: <${to}>`, `Subject: ${subject}`, `Message-ID: <${id}>`, ...(irt ? [`In-Reply-To: <${irt}>`, `References: <${irt}>`] : []), `Date: Mon, 16 Nov 2026 20:${String(n).padStart(2, "0")}:00 +0000`,
    `Content-Type: text/html; charset=utf-8`, ``, html + `<img src="https://pic${n}.example/p.gif" width="600" height="200">`, ``].join("\r\n");
  const f0 = fetched.length, feed0 = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get().n;
  await mod.default.email({ to, from: envFrom, rawSize: raw.length, raw, headers: new Headers({ subject, "message-id": `<${id}>`, from, date: "Mon, 16 Nov 2026 20:00:00 +0000" }), forward: async () => {}, setReject: () => {} }, env, ctx);
  await settle();
  const row = sq.prepare("SELECT m.id, m.thread_id, t.state, t.labels FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = ?").get(`<${id}>`) || {};
  const dec = row.id ? sq.prepare("SELECT decision FROM mention_decisions WHERE account = 'hub' AND id = ?").get(row.id)?.decision ?? null : null;
  return { ...row, msgid: id, dec, images: fetched.slice(f0).some((u) => u.includes(`pic${n}.example`)), announced: sq.prepare("SELECT COUNT(*) n FROM notify_feed").get().n - feed0 };
};
const rule = (id) => sq.prepare("SELECT kept, dropped FROM mention_rules WHERE id = ?").get(id) || {};

try {
  // ---------- the API ----------
  const ok = await api("POST", "/api/mention-rules", { pattern: "*@lakeside.example", words: ["SXSW", "South by Southwest"], scope: "hub" });
  check(ok.status === 200 && ok.body?.rule?.scope === "hub", `the scope "hub" is taken (${ok.status} ${ok.body?.error || ok.body?.rule?.scope})`);
  const bad = await api("POST", "/api/mention-rules", { pattern: "*@lakeside.example", words: ["SXSW"], scope: "letters" });
  check(bad.status === 400, `a scope that is not *, hub or a connected Gmail account is refused (${bad.status})`);
  const R = ok.body?.rule?.id;
  await api("POST", "/api/mention-rules", { pattern: "*@riverside.example", words: ["SXSW"], scope: "*" });   // every GMAIL account: not domain mail

  // ---------- arrival ----------
  const a = await mail({ subject: "Final hours: two-for-one passes", html: "<p>Two passes for the price of one until midnight." + LONG + "</p>" });
  check(a.state === "trash" && /mention-rule/.test(a.labels || "") && a.dec === "dropped", `no word: stored in Trash, labelled, decided "dropped" (${a.state}, ${a.labels}, ${a.dec})`);
  check(a.announced === 0 && !a.images, `and never announced, its pictures never fetched (announced ${a.announced}, images ${a.images})`);
  const b = await mail({ subject: "Our house is back this spring", html: "<p>Back at <b>SXSW</b> in March." + LONG + "</p>" });
  check(b.state === "inbox" && b.dec === "kept" && b.announced === 1, `a word keeps it, and it is announced (${b.state}, ${b.dec}, announced ${b.announced})`);
  const c = await mail({ subject: "x", html: '<img src="cid:a"><p>View online</p>' });
  check(c.state === "inbox" && c.dec === "unread", `almost no text of its own keeps it (${c.state}, ${c.dec})`);
  check(rule(R).dropped === 1 && rule(R).kept === 2, `the rule counts each (${JSON.stringify(rule(R))})`);
  // a reply in a conversation you wrote in: left
  const w = await mail({ subject: "Panel on Friday", html: "<p>Would you speak on Friday at SXSW?" + LONG + "</p>" });
  sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, message_id, body_text, raw_key, size_bytes, status, created_at) VALUES ('out-1', ?, 'out', 'sam@domain5.example', 'sam@domain5.example', 'Re: Panel on Friday', '<out-1@domain5.example>', 'Yes, count me in.', 'out/x.eml', 10, 'sent', '2026-11-16T20:30:00Z')").run(w.thread_id);
  const r = await mail({ subject: "Re: Panel on Friday", html: "<p>Great, the room is booked." + LONG + "</p>", irt: "out-1@domain5.example" });
  check(r.state === "inbox" && r.dec === "left" && r.thread_id === w.thread_id, `a reply in a conversation you wrote in is left in it (${r.state}, ${r.dec}, same thread ${r.thread_id === w.thread_id})`);
  const o = await mail({ from: "Someone <someone@elsewhere.example>", subject: "Hi", html: "<p>Nothing here." + LONG + "</p>" });
  check(o.state === "inbox" && o.dec === null, `another sender: no decision (${o.state}, ${o.dec})`);
  const g = await mail({ from: "River <news@riverside.example>", subject: "Hi", html: "<p>Nothing here." + LONG + "</p>" });
  check(g.state === "inbox" && g.dec === null, `a rule for every Gmail account does nothing to domain mail (${g.state}, ${g.dec})`);
  state.rulesDown = true;
  const d = await mail({ subject: "Final hours again", html: "<p>Two for one." + LONG + "</p>" });
  state.rulesDown = false;
  check(d.state === "inbox" && d.dec === null, `rules that cannot be read file the mail as before (${d.state}, ${d.dec})`);

  // ---------- the check of mail already here ----------
  if (typeof mod.mentionHubVerdict === "function") {
    const v = (rows) => mod.mentionHubVerdict(rows, ["SXSW"], ["sam@domain5.example"]);
    check(v([{ direction: "in", subject: "Big", body_text: "x".repeat(900_000), body_html: "" }]) === "unsure", "text cut at the store's cap is unsure");
    check(v([]) === "unsure", "no messages: unsure");
  } else check(false, "mentionHubVerdict is exported");
  const ck = await api("POST", "/api/mention-rules/check", { words: ["SXSW", "South by Southwest"], threads: [{ account: "hub", thread: a.thread_id }, { account: "hub", thread: b.thread_id }, { account: "hub", thread: w.thread_id }, { account: "hub", thread: "g2" }] });
  const dd = Object.fromEntries((ck.body?.results || []).map((x) => [x.thread, x.d]));
  check(ck.status === 200 && dd[a.thread_id] === "drop" && dd[b.thread_id] === "keep" && dd[w.thread_id] === "yours" && ck.body?.checked === 3, `stored conversations: none drops, a word keeps, one you wrote in is yours, a non-hub id is skipped (${ck.status} ${JSON.stringify(Object.values(dd))}, checked ${ck.body?.checked})`);
} catch (e) { check(false, "threw: " + (e?.stack || e).toString().split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall domain mention-rule checks passed");
process.exit(fails.length ? 1 : 0);
