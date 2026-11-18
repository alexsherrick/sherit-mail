#!/usr/bin/env node
// The hub half: a device that signs out leaves the notification lists. The real Worker's /logout runs against real
// migrations in real SQLite.
//  1. "Sign out of this device" deletes the phone the page names by its push id, or the browser by its Web Push endpoint; nothing else.
//  2. "Sign out everywhere" deletes every phone and browser, and refuses the old session at once.
//  3. A phone that signs in again registers again (POST /api/push/fcm with the new session).
//  4. A failure to delete never stops the sign-out: the cookie still goes and the failure is logged.
//  5. Signed out, /logout deletes nothing.
// Usage: node test/signout.mjs (exit 1 on any failed check)
// CONTROL: SIGNOUT_SRC=<an index.js from before the fix> node test/signout.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

// Split on ";" but keep a trigger body whole (as test/delta.mjs does).
const statements = (sql) => {
  const out = []; let buf = "";
  for (const part of sql.split(";")) {
    buf += part + ";";
    const open = (buf.match(/\bBEGIN\b/gi) || []).length, close = (buf.match(/\bEND\b/gi) || []).length;
    if (open === close) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; }
  }
  const t = buf.trim(); if (t && t !== ";") out.push(t);
  return out;
};
const OLD_PHONE = "fakeOldInst0:APA91bOldPixel10Pro-token-000000000000", NEW_PHONE = "fakeNewInst1:APA91bNewPixel11Pro-token-111111111111";
const EP_A = "https://fcm.googleapis.com/fcm/send/browser-a", EP_B = "https://web.push.apple.com/browser-b";
function buildDb() {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of statements(sql)) { try { sq.exec(stmt); } catch (_) {} }
  }
  const fcm = sq.prepare("INSERT INTO fcm_devices (token, ua) VALUES (?, ?)");
  fcm.run(OLD_PHONE, "SheritAndroid/1.8 (Android 17; Google Pixel 10 Pro)"); fcm.run(NEW_PHONE, "SheritAndroid/1.9 (Android 17; Google Pixel 11 Pro)");
  const web = sq.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, ua, created_at) VALUES (?, ?, 'p', 'a', ?, '2026-10-01T00:00:00.000Z')");
  web.run("sub-a", EP_A, "Chrome"); web.run("sub-b", EP_B, "Safari");
  return sq;
}
const d1Over = (sq, { failDeletes = false } = {}) => ({
  prepare(sql) {
    const mk = (params) => ({
      bind: (...a) => mk(a),
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => { if (failDeletes && /^DELETE FROM (fcm_devices|push_subscriptions)/.test(sql)) throw new Error("D1_ERROR: Network connection lost."); return { meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }; },
    });
    return mk([]);
  },
  batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; },
});

const SRC = readFileSync(process.env.SIGNOUT_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_signout_test.mjs`;   // next to index.js, so its relative imports resolve
writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
};
const exp = Date.now() + 86400000;
const cookie = async (gen) => `mh=${exp}.${gen}.${await hmac(SECRET, `${exp}.${gen}`)}`;
const pushId = async (token) => "fcm:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
const envFor = (sq, o) => ({ DB: d1Over(sq, o), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" });
const call = async (env, path, { method = "POST", body, gen = 0, signedIn = true } = {}) => {
  const headers = { Origin: "https://hub.example", "content-type": "application/json" };
  if (signedIn) headers.Cookie = await cookie(gen);
  const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: () => {} });
  return { status: r.status, setCookie: r.headers.get("set-cookie") || "" };
};
const phones = (sq) => sq.prepare("SELECT token FROM fcm_devices ORDER BY token").all().map((r) => r.token);
const browsers = (sq) => sq.prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").all().map((r) => r.endpoint);
const lastEvent = (sq, kind) => sq.prepare("SELECT detail FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind)?.detail || "";

// 1. this device only
{ const sq = buildDb(), env = envFor(sq);
  const r = await call(env, "/logout", { body: { everywhere: false, device: await pushId(OLD_PHONE) } });
  check(r.status === 200 && /Max-Age=0/.test(r.setCookie), `the phone signs out: 200 and the cookie cleared (${r.status})`);
  check(JSON.stringify(phones(sq)) === JSON.stringify([NEW_PHONE]) && browsers(sq).length === 2, `the phone it names leaves the list; the other phone and both browsers stay (${phones(sq).length} phones, ${browsers(sq).length} browsers)`);
  check(/phones=1 browsers=0/.test(lastEvent(sq, "logout")), `and the sign-out is logged with what it removed (${lastEvent(sq, "logout")})`);
  await call(env, "/logout", { body: { everywhere: false, endpoint: EP_A } });
  check(JSON.stringify(browsers(sq)) === JSON.stringify([EP_B]) && phones(sq).length === 1, `a browser that signs out leaves by its endpoint, and only it (${browsers(sq).join(", ")})`);
  await call(env, "/logout", { body: { everywhere: false, device: "fcm:not-a-push-id", endpoint: 42 } });
  check(phones(sq).length === 1 && browsers(sq).length === 1, "a name that is no device's removes nothing");
  await call(env, "/logout", { body: { everywhere: false } });
  check(phones(sq).length === 1 && browsers(sq).length === 1, "a sign-out that names nothing (the Mac and Windows apps) removes nothing");
}
// 2 and 3. everywhere, then a phone signs in again
{ const sq = buildDb(), env = envFor(sq);
  const r = await call(env, "/logout", { body: { everywhere: true } });
  const old = await call(env, "/api/me", { method: "GET" });
  check(r.status === 200 && old.status === 401, `"Sign out everywhere" signs out (${r.status}) and the old session is refused at once (${old.status})`);
  check(phones(sq).length === 0 && browsers(sq).length === 0, `and every phone and browser leaves the lists (${phones(sq).length} phones, ${browsers(sq).length} browsers left)`);
  check(/gen=1 phones=2 browsers=2/.test(lastEvent(sq, "logout_everywhere")), `logged with what it removed (${lastEvent(sq, "logout_everywhere")})`);
  const back = await call(env, "/api/push/fcm", { body: { token: NEW_PHONE, ua: "SheritAndroid/1.9" }, gen: 1 });
  check(back.status === 200 && JSON.stringify(phones(sq)) === JSON.stringify([NEW_PHONE]), `a phone that signs in again registers again with its new session (${back.status}, ${phones(sq).length} phone)`);
}
// 4. a failed delete never stops the sign-out
{ const sq = buildDb();
  const one = await call(envFor(sq, { failDeletes: true }), "/logout", { body: { everywhere: false, device: await pushId(NEW_PHONE) } });
  check(one.status === 200 && /Max-Age=0/.test(one.setCookie) && /unlist failed: D1_ERROR/.test(lastEvent(sq, "logout")), `with D1 failing, a sign-out still clears the cookie and logs the failure (${one.status}, ${lastEvent(sq, "logout")})`);
  const all = await call(envFor(sq, { failDeletes: true }), "/logout", { body: { everywhere: true } });
  check(all.status === 200 && /gen=1 unlist failed: D1_ERROR/.test(lastEvent(sq, "logout_everywhere")), `and "everywhere" still bumps the session generation and logs it (${all.status}, ${lastEvent(sq, "logout_everywhere")})`);
}
// 5. signed out, nothing is deleted
{ const sq = buildDb(), env = envFor(sq);
  const r = await call(env, "/logout", { body: { everywhere: true }, signedIn: false });
  const s = await call(env, "/logout", { body: { device: await pushId(OLD_PHONE) }, signedIn: false });
  check(r.status === 401 && s.status === 401 && phones(sq).length === 2 && browsers(sq).length === 2, `without a session /logout is refused and deletes nothing (${r.status}, ${s.status})`);
}

console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall sign-out checks passed");
process.exit(fails.length ? 1 : 0);
