#!/usr/bin/env node
// "Delete unless it mentions…" on the mail already here. The real Worker on real migrations, with a fake Gmail that
// answers threads.get?format=full and records every call:
//  - a conversation is judged as a new message is: a mention anywhere in it keeps it, one you wrote in is yours, one not read in full
//  or with almost no text is unsure, and only the rest is "drop";
//  - POST /api/mention-rules/check reads each named conversation of a connected Gmail account and says which; it moves nothing;
//  - it refuses bad words, skips an account that is not connected, an id that is not Gmail's and a repeat, checks at most 100, and a
//  conversation Gmail will not give is unsure, never drop.
// Usage: node test/mentioncheck.mjs (exit 1 on any failed check)
// CONTROL: MENTION_SRC=<an index.js from before the change> node test/mentioncheck.mjs must fail.
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
  batch: async (xs) => { await tick(); return xs.map((x) => ({ meta: { changes: Number(sq.prepare(x._sql).run(...x._p).changes) } })); },
});
const SRC = readFileSync(process.env.MENTION_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_mentioncheck_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

const E = "sam.owner.sxsw@gmail.com", W = ["SXSW", "South by Southwest"], OWN = [E, "sam.owner@gmail.com"];
const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const LONG = " Doors at seven, the bar opens at six, and the patio stays open late for everyone who comes along.";
// A Gmail message resource as threads.get?format=full gives it.
const msg = (id, { labels = ["INBOX"], from = "Lakeside House <hello@lakeside.example>", subject = "Hello", html = null, plain = null, apart = false } = {}) => ({
  id, threadId: "t" + id, labelIds: labels, payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: from }, { name: "Subject", value: subject }],
    parts: [...(plain !== null ? [{ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64u(plain) } }] : []),
      ...(html !== null ? [{ mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: apart ? { attachmentId: "big" } : { data: b64u(html) } }] : [])] } });

try {
  // ---------- the verdict ----------
  check(typeof mod.mentionThreadVerdict === "function", "mentionThreadVerdict is exported");
  if (typeof mod.mentionThreadVerdict === "function") {
    const v = (msgs) => mod.mentionThreadVerdict(msgs, W, OWN);
    check(v([msg("a1", { subject: "Final hours: two-for-one passes", html: "<p>Two passes for the price of one until midnight." + LONG + "</p>" })]) === "drop", "no word anywhere, read in full, enough text: drop");
    check(v([msg("a2", { subject: "Plans are coming together for SXSW 2023", html: "<p>" + LONG + "</p>" })]) === "keep", "a word in the subject: keep");
    check(v([msg("a3", { html: "<p>" + LONG + "</p>" }), msg("a4", { html: "<p>See you at <b>South by Southwest</b>." + LONG + "</p>" })]) === "keep", "a word in any message of the conversation: keep");
    check(v([msg("a5", { html: "<p>" + LONG + "</p>" }), msg("a6", { labels: ["SENT"], from: E, plain: "Count me in." + LONG })]) === "yours", "a conversation you wrote in: yours, never dropped");
    check(v([msg("a7", { html: "", apart: true, plain: null })]) === "unsure", "a part Gmail keeps apart (not read in full): unsure");
    check(v([msg("a8", { html: '<img src="cid:x"><p>View online</p>' })]) === "unsure", "almost no text of its own (a picture mail): unsure");
    check(v([]) === "unsure", "no messages: unsure");
    check(v([msg("a9", { html: "<p>Sent to sam.owner.sxsw@gmail.com." + LONG + "</p>" })]) === "drop", "the user's own address naming the account is not a mention");
    check(v([msg("b1", { html: "<p>Nothing here." + LONG + "</p>" }), msg("b2", { html: "<p>" + LONG + "</p>", apart: true })]) === "unsure", "one message read in full with no word, another not read in full: unsure");
  }

  // ---------- the route ----------
  const sq = fresh(), db = d1(sq), calls = [];
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
  const env = { DB: db, GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", FORWARD_TO: "sam.owner@gmail.com", DOMAINS: "yourdomain.example", CLI_TOKEN: "test-token", SESSION_SECRET: "s", EMAIL: { send: async () => {} } };
  const sealed = await mod.sealToken(env, "refresh-token", E);
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, label) VALUES (?, ?, ?, 's', 'active', '2026-10-07', 'SXSW')").run(E, sealed.enc, sealed.iv);
  const threads = {
    "1a2b3c01": [msg("m1", { subject: "Final hours: two-for-one passes", html: "<p>Two for one." + LONG + "</p>" })],
    "1a2b3c02": [msg("m2", { subject: "Our house is back this spring", html: "<p>Back at SXSW in March." + LONG + "</p>" })],
    "1a2b3c03": [msg("m3", { html: "<p>" + LONG + "</p>" }), msg("m4", { labels: ["SENT"], from: E, plain: "Thanks!" + LONG })],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => {
    const url = String(u), json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    calls.push(`${(o.method || "GET").toUpperCase()} ${url}`);
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    const x = url.match(/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/threads\/([^/?]+)\?format=full$/);
    if (x && threads[x[1]]) return json({ id: x[1], messages: threads[x[1]] });
    if (x && x[1].startsWith("f")) return json({ error: { code: 500, message: "backend error" } }, 500);
    if (x) return json({ id: x[1], messages: [msg("z" + x[1], { html: "<p>Nothing to see." + LONG + "</p>" })] });
    return json({ error: "unmocked " + url }, 404);
  };
  try {
    const api = async (body) => { const r = await mod.default.fetch(new Request("https://mail.yourdomain.example/api/mention-rules/check", { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json", origin: "https://mail.yourdomain.example" }, body: JSON.stringify(body) }), env, { waitUntil: () => {} }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const r = await api({ words: W, threads: [{ account: E, thread: "1a2b3c01" }, { account: E.toUpperCase(), thread: "1a2b3c02" }, { account: E, thread: "1a2b3c03" }, { account: E, thread: "f0f0f0f0" },
      { account: "dana.park@gmail.com", thread: "1a2b3c01" }, { account: E, thread: "not-a-gmail-id" }, { account: E, thread: "1a2b3c01" }] });
    const d = Object.fromEntries((r.body?.results || []).map((x) => [x.thread + (x.account === E ? "" : "@" + x.account), x.d]));
    check(r.status === 200 && d["1a2b3c01"] === "drop" && d["1a2b3c02"] === "keep" && d["1a2b3c03"] === "yours", `the route judges each conversation: the sale goes, the SXSW one and the one you wrote in stay (${r.status} ${JSON.stringify(d)})`);
    check(d["f0f0f0f0"] === "unsure", `a conversation Gmail will not give is unsure, never drop (${d["f0f0f0f0"]})`);
    check(r.body?.checked === 4 && Object.keys(d).length === 4, `an account that is not connected, an id that is not Gmail's and a repeat are skipped (${r.body?.checked}, ${Object.keys(d)})`);
    check(!calls.some((c) => c.startsWith("POST https://gmail") || /\/(trash|modify|batchModify)\b/.test(c)), `nothing is moved in Gmail (${calls.filter((c) => c.includes("gmail")).length} Gmail calls, all reads)`);
    const bad = await api({ words: ["x"], threads: [{ account: E, thread: "1a2b3c01" }] });
    check(bad.status === 400, `a one-letter word is refused (${bad.status})`);
    const none = await api({ words: [], threads: [] });
    check(none.status === 400, `no words is refused (${none.status})`);
    calls.length = 0;
    const many = await api({ words: W, threads: Array.from({ length: 130 }, (_, i) => ({ account: E, thread: (0x2000000 + i).toString(16) })) });
    const gets = calls.filter((c) => c.includes("/threads/")).length;
    check(many.status === 200 && many.body?.checked === 100 && many.body?.capped === true && gets === 100, `at most 100 are read, and the answer says it stopped (${many.body?.checked}, capped ${many.body?.capped}, ${gets} reads)`);
    const unauth = await mod.default.fetch(new Request("https://mail.yourdomain.example/api/mention-rules/check", { method: "POST", headers: { "content-type": "application/json", origin: "https://mail.yourdomain.example" }, body: JSON.stringify({ words: W, threads: [] }) }), env, { waitUntil: () => {} });
    check(unauth.status === 401 || unauth.status === 302 || unauth.status === 403, `without a session or the CLI token it answers nothing (${unauth.status})`);
  } finally { globalThis.fetch = realFetch; }
} catch (e) { check(false, "threw: " + (e?.stack || e).toString().split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall mention-check checks passed");
process.exit(fails.length ? 1 : 0);
