#!/usr/bin/env node
// Connect Gmail from an app whose default browser has no hub session. The Mac, Android and Windows apps send /auth/gmail to
// the default browser, since Google refuses OAuth in an embedded web view; that browser was usually never signed in to the hub, so
// connect stopped at "Sign in to the hub first". The signed-in app now asks for a one-time ticket and the browser starts with it.
// The real Worker on real migrations and SQLite, with a fake Google.
//  - POST /api/gmail/ticket needs the session; it answers a ticket;
//  - /auth/gmail?ticket=… with no session goes to Google and sets the state cookie; the same ticket again, an expired one, a made-up
//  one, and no ticket at all are refused, and none of them reaches Google;
//  - the callback in that browser (state cookie, no session) connects the account and says so on a page with no script;
//  - the callback with a state the cookie does not match is still refused; a signed-in browser is still sent back to the app;
//  - the ticket rows are never handed to the app with the prefs.
// Usage: node test/gmailticket.mjs (exit 1 on any failed check)
// CONTROL: GMAILTICKET_SRC=<an index.js from before the fix> node test/gmailticket.mjs must fail.
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
  prepare(sql) {
    const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a),
      all: async () => { await tick(); return { results: sq.prepare(sql).all(...p) }; },
      first: async () => { await tick(); return sq.prepare(sql).get(...p) ?? null; },
      run: async () => { await tick(); const r = sq.prepare(sql).run(...p); return { meta: { changes: Number(r.changes) } }; } });
    return mk([]);
  },
  batch: async (xs) => { await tick(); return xs.map((x) => ({ meta: { changes: Number(sq.prepare(x._sql).run(...x._p).changes) } })); },
};
const SRC = readFileSync(process.env.GMAILTICKET_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_gmailticket_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

// ---------- a fake Google: the token exchange and tokeninfo; every request to accounts.google.com would be a navigation, never a fetch
const E = "sam.owner@gmail.com", SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const google = { nonce: "", asked: [] };
globalThis.fetch = async (input) => {
  const u = String(typeof input === "string" ? input : input.url); google.asked.push(u.split("?")[0]);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (u === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600, refresh_token: "rt", id_token: "idt", scope: `openid email ${SCOPE}` });
  if (u.startsWith("https://oauth2.googleapis.com/tokeninfo")) return json({ aud: "cid", iss: "https://accounts.google.com", nonce: google.nonce, email: E, email_verified: "true" });
  return json({ error: "unmocked " + u }, 404);
};
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const SECRET = "test-session-secret";
const env = { DB: db, GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", FORWARD_TO: "me@gmail.com", DOMAINS: "hub.example", SESSION_SECRET: SECRET, EMAIL: { send: async () => {} } };
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (data) => b64u(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(data)));
const exp = Date.now() + 86400000, SESSION = `mh=${exp}.0.${await hmac(`${exp}.0`)}`;
const call = async (path, { method = "GET", cookie = "", body } = {}) => {
  const headers = { Origin: "https://hub.example" }; if (cookie) headers.Cookie = cookie;
  const waits = []; const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers, body, redirect: "manual" }), env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
  await Promise.allSettled(waits); return r;
};
const toGoogle = (r) => r.status === 302 && /^https:\/\/accounts\.google\.com\//.test(r.headers.get("location") || "");
const stateOf = (r) => (/mh_gmail=([^;]+)/.exec(r.headers.get("set-cookie") || "") || [])[1] || "";

// ---------- the ticket ----------
const noSession = await call("/api/gmail/ticket", { method: "POST" });
check(noSession.status === 401, `no ticket without the hub session (${noSession.status})`);
const tr = await call("/api/gmail/ticket", { method: "POST", cookie: SESSION });
const ticket = (await tr.json().catch(() => ({}))).ticket || "";
check(tr.status === 200 && /^[A-Za-z0-9_-]{40,60}$/.test(ticket), `the signed-in app gets a ticket (${tr.status}, ${ticket.length} characters)`);

// ---------- a browser with no session ----------
const start = await call("/auth/gmail?ticket=" + encodeURIComponent(ticket));
const state = stateOf(start);
check(toGoogle(start) && state.split(".").length === 3, `with the ticket, a browser with no session is sent to Google with a state cookie (${start.status} ${(start.headers.get("location") || "").slice(0, 40)})`);
const again = await call("/auth/gmail?ticket=" + encodeURIComponent(ticket));
check(again.status === 401 && !toGoogle(again) && /already used/.test(await again.text()), `the same ticket again is refused (${again.status})`);
const madeUp = await call("/auth/gmail?ticket=" + "A".repeat(43));
check(madeUp.status === 401 && !toGoogle(madeUp), `a made-up ticket is refused (${madeUp.status})`);
const old = "B".repeat(43);
sq.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)").run(`gmailticket:${old}`, JSON.stringify({ exp: Date.now() - 1000 }), new Date().toISOString());
const expired = await call("/auth/gmail?ticket=" + old);
check(expired.status === 401 && !toGoogle(expired), `an expired ticket is refused (${expired.status})`);
const bare = await call("/auth/gmail");
check(bare.status === 401 && !toGoogle(bare) && /Sign in to the hub first/.test(await bare.text()), `no ticket and no session: "Sign in to the hub first", as before (${bare.status})`);
const signedStart = await call("/auth/gmail", { cookie: SESSION });
check(toGoogle(signedStart), `a signed-in browser needs no ticket, as before (${signedStart.status})`);

// ---------- the callback ----------
google.nonce = state.split(".")[1];
const wrong = await call(`/auth/gmail/callback?code=c&state=${encodeURIComponent(stateOf(signedStart))}`, { cookie: `mh_gmail=${state}` });
check(wrong.status === 400 && !sq.prepare("SELECT 1 FROM gmail_accounts WHERE email = ?").get(E), `a state the cookie does not match is refused, nothing connected (${wrong.status})`);
const cb = await call(`/auth/gmail/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: `mh_gmail=${state}` });
const page = await cb.text(), row = sq.prepare("SELECT email, status FROM gmail_accounts WHERE email = ?").get(E);
check(cb.status === 200 && row && row.status === "active", `the callback in that browser connects ${E} (${cb.status}, ${row ? row.status : "no row"})`);
check(/is connected\. Go back to Sherit Mail/.test(page) && /default-src 'none'/.test(cb.headers.get("content-security-policy") || "") && /mh_gmail=;/.test(cb.headers.get("set-cookie") || ""), `and says so on a page with no script, clearing the state cookie`);
google.nonce = stateOf(signedStart).split(".")[1];
const cb2 = await call(`/auth/gmail/callback?code=c&state=${encodeURIComponent(stateOf(signedStart))}`, { cookie: `${SESSION}; mh_gmail=${stateOf(signedStart)}` });
check(cb2.status === 302 && (cb2.headers.get("location") || "").startsWith("/?gmail="), `a signed-in browser is sent back to the app, as before (${cb2.status} ${cb2.headers.get("location")})`);

// ---------- the ticket rows stay on the hub ----------
await call("/api/gmail/ticket", { method: "POST", cookie: SESSION });
const prefs = await (await call("/api/prefs", { cookie: SESSION })).json().catch(() => ({}));
check(!JSON.stringify(prefs).includes("gmailticket"), `the ticket rows are not in the prefs the app reads`);

console.log(fails.length ? `${fails.length} failed` : "all Gmail ticket checks passed");
process.exit(fails.length ? 1 : 0);
