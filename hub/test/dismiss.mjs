#!/usr/bin/env node
// Execution checks for the Worker half of "a notification for mail already dealt with keeps sitting on the
// other device's lock screen". Founder: mail trashed on the phone or the computer still left its
// notification on the phone's lock screen; Spark clears them on its own.
//
// The old mechanism attached handled keys to the NEXT MAIL PUSH. Production, 20:14:59 last push / 20:18:40 the triage / nothing
// after: with no new mail there is no next push, so nothing ever cleared. These checks drive the REAL Worker handlers against
// real migrations and real SQLite, with only `fetch` stubbed, and assert the three things the fix rests on:
//  1. reporting handled mail now sends a dismissal of its own, immediately, with no mail involved;
//  2. it goes ONLY to a device actually holding that notification, and NEVER back to the device that did the work;
//  3. Gmail's history feed is read for label changes, so mail dealt with in the Gmail app counts too.
// Usage: node test/dismiss.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const MAC = "00000000-0000-4000-8000-00000000000a", PHONE = "00000000-0000-4000-8000-00000000000b";   // made-up device ids
const MAC_EP = "https://fcm.googleapis.com/mac", PHONE_EP = "https://fcm.googleapis.com/phone";
const KEY = "sam.owner@gmail.com|18f00000000a0001";                                               // a made-up trashed thread

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
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
// Real P-256 material. Made-up key bytes make `buildPushPayload` throw "Invalid keyData" before a single fetch leaves, which
// looks exactly like "no push was sent": a green-for-the-wrong-reason trap this test fell into once already.
const rawPub = async (kp) => b64u(Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)));
const gen = () => crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const VAPID_PUB = b64u(Buffer.from(await crypto.subtle.exportKey("raw", vapidPair.publicKey)));
const VAPID_PRIV = (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)).d;
const devicePair = await gen();
const P256DH = await rawPub(devicePair);
const AUTH = b64u(Buffer.from(crypto.getRandomValues(new Uint8Array(16))));
function buildDb({ macLive = [], phoneLive = [], phoneCaps = ["dismiss2"] } = {}) {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of statements(sql)) { try { sq.exec(stmt); } catch (_) {} }
  }
  const ins = sq.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, ua, created_at, live_tags, caps) VALUES (?, ?, ?, ?, ?, '2026-09-10T19:02:31.808Z', ?, ?)`);
  ins.run(MAC, MAC_EP, P256DH, AUTH, "Mac", JSON.stringify(macLive), JSON.stringify(["dismiss2"]));
  ins.run(PHONE, PHONE_EP, P256DH, AUTH, "Android", JSON.stringify(phoneLive), JSON.stringify(phoneCaps));
  return sq;
}
const d1Over = (sq) => ({
  prepare(sql) {
    const mk = (params) => ({
      bind: (...a) => mk(a),
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => Promise.all(xs.map((x) => x.run())),
});

const SRC = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_dismiss.mjs`;
writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

const SECRET = "test-session-secret";
const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
};
const exp = Date.now() + 86400000;
const COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;

// Every push leaves as an ordinary fetch to the subscription endpoint, so stubbing fetch is enough to see exactly who was woken.
const realFetch = globalThis.fetch;
function capture() {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url?.url || url);
    if (u.startsWith("https://fcm.googleapis.com/")) { sent.push({ to: u, bytes: (init.body || "").length || 0 }); return new Response("", { status: 201 }); }
    return new Response("{}", { status: 200 });
  };
  return sent;
}
const ENV = (sq) => ({ DB: d1Over(sq), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x",
  VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_SUBJECT: "mailto:x@example.com" });
const call = (sq, method, path, body) => mod.default.fetch(new Request("https://hub.example" + path, {
  method, headers: { Cookie: COOKIE, Origin: "https://hub.example", "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
}), ENV(sq), { waitUntil: (p) => p });

// ---------- 1. the incident: the Mac reports a trash, the phone is holding the notification ----------
{
  const sq = buildDb({ macLive: [KEY], phoneLive: [KEY] });
  const sent = capture();
  const r = await call(sq, "POST", "/api/notify/handled", { keys: [KEY], endpoint: MAC_EP });
  await new Promise((r2) => setTimeout(r2, 50));
  globalThis.fetch = realFetch;
  check(r.status === 200, `the report is accepted (${r.status})`);
  check(sent.length === 1, `exactly one device is woken, with no mail involved — ${sent.length} push(es)`);
  check(sent[0]?.to === PHONE_EP, `and it is the PHONE, not the Mac that did the trashing — ${sent[0]?.to}`);
  const ring = JSON.parse(sq.prepare("SELECT value FROM prefs WHERE key='handled'").get()?.value || "[]");
  check(ring[0]?.k === KEY && ring[0]?.by === MAC, `the ring records which device acted — by=${ring[0]?.by === MAC ? "mac" : ring[0]?.by}`);
  const phoneTags = JSON.parse(sq.prepare("SELECT live_tags FROM push_subscriptions WHERE id=?").get(PHONE)?.live_tags || "[]");
  check(!phoneTags.includes(KEY), `and the phone is no longer recorded as holding it — ${JSON.stringify(phoneTags)}`);
}
// ---------- 2. a device with nothing on screen is left asleep ----------
{
  const sq = buildDb({ macLive: [KEY], phoneLive: [] });     // the phone never got this one, or already cleared it
  const sent = capture();
  await call(sq, "POST", "/api/notify/handled", { keys: [KEY], endpoint: MAC_EP });
  await new Promise((r2) => setTimeout(r2, 50));
  globalThis.fetch = realFetch;
  check(sent.length === 0, `no device is holding it, so nobody is woken — ${sent.length} push(es)`);
}
// ---------- 3. `by` survives the Gmail feed re-observing the same action ----------
{
  const sq = buildDb({ macLive: [KEY], phoneLive: [KEY] });
  const sent = capture();
  await call(sq, "POST", "/api/notify/handled", { keys: [KEY], endpoint: MAC_EP });
  await new Promise((r2) => setTimeout(r2, 50));
  const before = sent.length;
  // the poll sees the same label change a minute later and re-adds the key with no device attached
  await mod.addHandled?.(ENV(sq), [KEY], null);
  const ring = JSON.parse(sq.prepare("SELECT value FROM prefs WHERE key='handled'").get()?.value || "[]");
  globalThis.fetch = realFetch;
  check(before === 1, `the first report woke the phone (${before})`);
  check(ring.find((x) => x.k === KEY)?.by === MAC, `and the Gmail feed re-adding it does NOT null out \`by\` — by=${ring.find((x) => x.k === KEY)?.by === MAC ? "mac" : ring.find((x) => x.k === KEY)?.by}`);
}
// ---------- 3b. a device still running the worker from before this change is NOT sent a push that shows nothing ----------
{
  const sq = buildDb({ macLive: [KEY], phoneLive: [KEY], phoneCaps: [] });   // phone has not re-registered since the deploy
  const sent = capture();
  await call(sq, "POST", "/api/notify/handled", { keys: [KEY], endpoint: MAC_EP });
  await new Promise((r2) => setTimeout(r2, 50));
  globalThis.fetch = realFetch;
  check(sent.length === 0, `an old service worker gets no dismiss push — it would end with an empty shade and spend budget (${sent.length})`);
  const ring = JSON.parse(sq.prepare("SELECT value FROM prefs WHERE key='handled'").get()?.value || "[]");
  check(ring.some((x) => x.k === KEY), "but the key is still in the ring, so the old piggyback still clears it on the next mail push");
}
// ---------- 4. the Gmail history fold: real record shapes, taken from the live mailbox on 2026-09-18 ----------
{
  const state = new Map();
  // the shapes (ids made up) from GET /gmail/v1/users/me/history on sam.owner@gmail.com, 2026-09-18
  const added = mod.foldHistory([
    { id: "50000001", labelsRemoved: [{ message: { id: "18f00000000a0001", threadId: "18f00000000a0001" }, labelIds: ["UNREAD"] }] },
    { id: "50000002", labelsAdded: [{ message: { id: "18f00000000a0001", threadId: "18f00000000a0001" }, labelIds: ["TRASH"] }] },
    { id: "50000003", labelsRemoved: [{ message: { id: "18f00000000a0001", threadId: "18f00000000a0001" }, labelIds: ["INBOX"] }] },
    { id: "50000000", messagesAdded: [{ message: { id: "18f00000000b0002", threadId: "18f00000000b0002", labelIds: ["CATEGORY_PROMOTIONS", "UNREAD", "INBOX"] } }] },
  ], state);
  check(state.get("18f00000000a0001") === true, "a thread trashed in Gmail reads as handled");
  check(state.get("18f00000000b0002") === false, "a thread that just received new mail does not");
  check(added.length === 1 && added[0].id === "18f00000000b0002", `and only the genuinely new message is handed on for notifying — ${added.map((m) => m.id)}`);
}
{ // the last word wins, in both directions
  const s1 = new Map();
  mod.foldHistory([
    { id: "1", labelsRemoved: [{ message: { threadId: "T" }, labelIds: ["UNREAD"] }] },
    { id: "2", labelsAdded: [{ message: { threadId: "T" }, labelIds: ["UNREAD"] }] },
  ], s1);
  check(s1.get("T") === false, "read and then marked unread again is NOT handled — the notification must stay");
  const s2 = new Map();
  mod.foldHistory([
    { id: "1", labelsAdded: [{ message: { threadId: "T" }, labelIds: ["TRASH"] }] },
    { id: "2", messagesAdded: [{ message: { id: "m", threadId: "T", labelIds: ["INBOX"] } }] },
  ], s2);
  check(s2.get("T") === false, "a reply landing after the trash puts the thread back in play");
  const s3 = new Map();
  mod.foldHistory([{ id: "1", labelsRemoved: [{ message: { threadId: "T" }, labelIds: ["INBOX"] }] }], s3);
  check(s3.get("T") === true, "an archive — INBOX removed, nothing added — reads as handled");
}
{ // the request the fold depends on actually asks for those records
  const src = readFileSync(HUB + "src/index.js", "utf8");
  for (const t of ["historyTypes=messageAdded", "historyTypes=labelAdded", "historyTypes=labelRemoved", "historyTypes=messageDeleted"])
    check(src.includes(t), `the history request asks for ${t.split("=")[1]}`);
  check(src.includes("labelId=INBOX"), "and keeps the INBOX filter, which was measured to lose no INBOX removal");
}
console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall dismissal checks passed");
process.exit(fails.length ? 1 : 0);
