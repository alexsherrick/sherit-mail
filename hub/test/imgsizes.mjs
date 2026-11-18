#!/usr/bin/env node
// The hub's side of the picture sizes, on real migrations and SQLite with R2 in memory:
//  - /api/img serves the size asked: w=1080 the phone's size, else the desktop's, else the original; a written size is kept a year
//  and goes to the edge cache, an original for 5 minutes and never to the edge cache;
//  - a warm-up (x-warm: 1) is answered from what the hub holds and never reaches a sender, even for a picture it has never seen;
//  - a shown picture's last-shown day is written once a day;
//  - at arrival a picture wider than 1080 px or 500 KB and over is queued for the img Worker, a small one is not, and every kept one
//  is noted as stored; a picture whose original was replaced by its desktop size counts as held, so it is not fetched again;
//  - the daily sweep gives every picture stored before img_seen a row dated by its upload, then deletes, original, sizes and rows,
//  every picture not shown in 90 days, and keeps the rest; the listing's cursor is kept server-side and ends "done".
// Usage: node test/imgsizes.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); return c; };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; const open = (buf.match(/\bBEGIN\b/gi) || []).length, close = (buf.match(/\bEND\b/gi) || []).length; if (open === close) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const stripComments = (sql) => sql.split("\n").map((l) => { let q = false; for (let i = 0; i < l.length; i++) { if (l[i] === "'") q = !q; if (!q && l[i] === "-" && l[i + 1] === "-") return l.slice(0, i); } return l; }).join("\n");
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").filter((x) => x.endsWith(".sql")).sort()) for (const st of statements(stripComments(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
let writes = 0;
const d1 = (sq) => ({ prepare(sql) { const mk = (p) => ({ sql, bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) ?? null, run: async () => { if (/img_seen/.test(sql)) writes++; return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; } }); return mk([]); }, batch: async (xs) => Promise.all(xs.map((x) => (/\bRETURNING\b/i.test(x.sql) ? x.all() : x.run()))) });   // D1 returns a RETURNING statement's rows in a batch
const stub = (src) => src.replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};").replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";').replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = HUB + "test/_imgsizes_hub.mjs"; writeFileSync(tmp, stub(readFileSync(HUB + "src/index.js", "utf8"))); const m = await import(tmp); unlinkSync(tmp);

const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (s, d) => b64u(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(s), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(d)));
const exp = Date.now() + 86400000, COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;
const png = (w, h, n) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, w >> 24, w >> 16 & 255, w >> 8 & 255, w & 255, h >> 24, h >> 16 & 255, h >> 8 & 255, h & 255]); return b; };
const jpg = (w, h, n) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3]); return b; };
const sender = []; const WIDE = png(1600, 900, 3000), SMALL = png(300, 200, 2000), HEAVY = png(800, 600, 600_000);
const MIDPNG = png(500, 500, 40_000), MIDJPG = jpg(500, 500, 300_000), MIDPNG_AS_JPG = png(500, 500, 30_000);
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
  sender.push(u.pathname); const b = { "/wide.png": WIDE, "/small.png": SMALL, "/heavy.png": HEAVY, "/new.png": SMALL, "/again.png": WIDE, "/mid.png": MIDPNG, "/mid.jpg": MIDJPG, "/png-named.jpg": MIDPNG_AS_JPG, "/unkept.png": SMALL }[u.pathname];
  return b ? new Response(b, { headers: { "content-type": "image/png", "content-length": String(b.length) } }) : new Response("no", { status: 404 });
};
const edge = new Map(); globalThis.caches = { default: { match: async (req) => edge.get(req.url)?.clone(), put: async (req, res) => { edge.set(req.url, res); } } };
const IMG = (p) => "https://img.sender.example" + p, shaOf = (u) => createHash("sha256").update(new URL(u).href).digest("hex");

const sq = buildDb(), r2 = new Map();
const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k) => (r2.has(k) ? { body: new Response(r2.get(k).buf).body, httpMetadata: { contentType: r2.get(k).ct }, customMetadata: r2.get(k).meta } : null),
  put: async (k, v, o) => { r2.set(k, { buf: new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer || v), ct: o?.httpMetadata?.contentType, uploaded: new Date() }); }, delete: async (k) => { for (const x of [].concat(k)) r2.delete(x); },
  list: async ({ prefix, limit = 1000, cursor }) => { const keys = [...r2.keys()].filter((k) => k.startsWith(prefix)).sort(); const at = cursor ? +cursor : 0, page = keys.slice(at, at + limit); return { objects: page.map((k) => ({ key: k, uploaded: r2.get(k).uploaded })), truncated: at + limit < keys.length, cursor: String(at + limit) }; } };
const env = { DB: d1(sq), STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
const call = (path, headers = {}) => { const waits = []; return m.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE, ...headers } }), env, { waitUntil: (p) => waits.push(p) }).then(async (r) => { const len = (await r.arrayBuffer()).byteLength; await Promise.allSettled(waits); return { status: r.status, source: r.headers.get("x-img-source"), cc: r.headers.get("cache-control"), len }; }); };
const key = (await (await m.default.fetch(new Request("https://hub.example/api/me", { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} })).json()).img_key;
const open = (u, extra = "", h) => call("/api/img?u=" + encodeURIComponent(u) + "&k=" + key + extra, h);

// 1. sizes
{
  const u = IMG("/held.png"), s = shaOf(u);
  r2.set("img/" + s, { buf: SMALL, ct: "image/png", uploaded: new Date() });
  let r = await open(u, "&w=1080");
  check(r.source === "r2" && r.cc === "private, max-age=300" && !edge.size, `with only the original, it is served, kept 5 minutes, not edge-cached (${r.source}, ${r.cc}, edge ${edge.size})`);
  r2.set(`imgv/${s}-1600`, { buf: new Uint8Array(50), ct: "image/webp", meta: { w: "1600" } });
  r = await open(u, "&w=1080");
  check(r.source === "r2-1600" && r.len === 50 && r.cc === "private, max-age=300" && !edge.size, `the phone gets the desktop size while it has none of its own, kept 5 minutes and not edge-cached, so its own replaces it (${r.source}, ${r.cc}, edge ${edge.size})`);
  const u2 = IMG("/narrow.png"), s2 = shaOf(u2); r2.set(`imgv/${s2}-1600`, { buf: new Uint8Array(20), ct: "image/webp", meta: { w: "900" } });
  const n = await open(u2, "&w=1080");
  check(n.cc === "private, max-age=31536000, immutable", `a desktop size no wider than the phone's is the phone's too, final (${n.cc})`); edge.clear();
  r2.set(`imgv/${s}-1080`, { buf: new Uint8Array(30), ct: "image/webp" });
  r = await open(u, "&w=1080"); const r16 = await open(u, "&w=1600"), rOld = await open(u);
  check(r.source === "r2-1080" && r.len === 30 && r16.source === "r2-1600" && r16.len === 50 && rOld.len === 50, `then its own; the desktop and an app that sends no size get the desktop size (${r.source} ${r.len}, ${r16.source} ${r16.len}, none ${rOld.len})`);
  const again = await open(u, "&w=1080");
  check(again.source === "edge" && again.len === 30, `a written size's next open is the edge cache's (${again.source})`);
}
// 1b. an original deleted between the hub's reads, its desktop size written meanwhile: the size is served, no sender asked
{
  const u = IMG("/race.png"), s = shaOf(u), get0 = STORE.get; let variantReads = 0;
  STORE.get = async (k) => { if (k === `imgv/${s}-1600`) { variantReads++; if (variantReads === 1) return null; return { body: new Response(new Uint8Array(33)).body, httpMetadata: { contentType: "image/webp" } }; } return get0(k); };
  const n0 = sender.length, r = await open(u, "&w=1600"); STORE.get = get0;
  check(r.status === 200 && r.source === "r2-1600" && r.len === 33 && sender.length === n0, `an original gone between the reads is answered with the size written meanwhile, never the sender (${r.source}, ${sender.length - n0} asked)`);
}
// 2. warm-ups never reach a sender
{
  const n0 = sender.length, cold = await open(IMG("/never.png"), "&w=1600", { "x-warm": "1" });
  check(cold.status === 204 && sender.length === n0, `a warm-up of a picture the hub does not hold is 204 and asks no sender (${cold.status}, ${sender.length - n0} asked)`);
  sq.prepare("INSERT INTO img_queue (hk, url, state, kind, tries, next_at, at) VALUES (?, ?, 'pending', 'new', 0, ?, ?)").run(1, IMG("/queued.png"), new Date().toISOString(), new Date().toISOString());
  const t0 = Date.now(), q = await open(IMG("/queued.png"), "", { "x-warm": "1" });
  check(q.status === 204 && Date.now() - t0 < 1000, `nor waits for an arrival fetch (${q.status}, ${Date.now() - t0} ms)`);
  const held = await open(IMG("/held.png"), "&w=1080", { "x-warm": "1" });
  check(held.status === 200, `a held picture is warmed (${held.status})`);
}
// 3. last shown, once a day
{
  const s = shaOf(IMG("/held.png")), row = () => sq.prepare("SELECT stored_at, seen_at FROM img_seen WHERE sha = ?").get(s);
  check(!!row()?.seen_at && row().seen_at.slice(0, 10) === new Date().toISOString().slice(0, 10), `a shown picture's last-shown day is written (${row()?.seen_at})`);
  const w0 = writes; edge.clear(); await open(IMG("/held.png"), "&w=1080"); await open(IMG("/held.png"), "&w=1600");
  check(writes === w0, `and not again the same day (${writes - w0} more writes)`);
}
// 4. arrival: queued by width or weight, noted as stored, a replaced original still held
{
  const r = await m.prefetchImages(env, ["/wide.png", "/small.png", "/heavy.png"].map((p) => `<img src="${IMG(p)}" width="40" height="30">`).join(""), "test", { left: { images: 99, bytes: 1e9 } });
  const work = sq.prepare("SELECT key FROM img_work ORDER BY key").all().map((x) => x.key), want = ["/wide.png", "/heavy.png"].map((p) => "img/" + shaOf(IMG(p))).sort();
  check(r.stored === 3 && JSON.stringify(work) === JSON.stringify(want), `the 1600 px picture and the 600 KB one are queued for sizes, the small one is not (${work.length} queued)`);
  sq.prepare("DELETE FROM img_work").run();
  const r2m = await m.prefetchImages(env, ["/mid.png", "/mid.jpg", "/png-named.jpg"].map((p) => `<img src="${IMG(p)}" width="40" height="30">`).join(""), "test", { left: { images: 99, bytes: 1e9 } });
  const mid = sq.prepare("SELECT key FROM img_work ORDER BY key").all().map((x) => x.key), wantMid = ["/mid.png", "/png-named.jpg"].map((p) => "img/" + shaOf(IMG(p))).sort();
  check(r2m.stored === 3 && JSON.stringify(mid) === JSON.stringify(wantMid), `a 40 KB PNG 500 px wide is queued, and a 30 KB PNG sent as .jpg, but not a 300 KB JPEG of the same width (${mid.length} queued)`);
  const seen = ["/wide.png", "/small.png", "/heavy.png"].every((p) => sq.prepare("SELECT 1 FROM img_seen WHERE sha = ?").get(shaOf(IMG(p))));
  check(seen, "every kept picture is noted as stored");
  const s = shaOf(IMG("/again.png")); r2.set(`imgv/${s}-1600`, { buf: new Uint8Array(40), ct: "image/webp", uploaded: new Date() });
  const n0 = sender.length, again = await m.prefetchImages(env, `<img src="${IMG("/again.png")}" width="40" height="30">`, "test", { left: { images: 99, bytes: 1e9 } });
  check(again.had === 1 && sender.length === n0, `a picture whose original its desktop size replaced is held, not fetched again (${again.had} held, ${sender.length - n0} asked)`);
}
// 5. the daily sweep
{
  const old = new Date(Date.now() - 120 * 86400e3), sha = (n) => n.toString(16).padStart(64, "0");
  r2.set("img/" + sha(1), { buf: SMALL, ct: "image/png", uploaded: old });                                   // before img_seen, never shown: goes
  r2.set("img/" + sha(2), { buf: SMALL, ct: "image/png", uploaded: old });                                   // before img_seen, shown last week: stays
  sq.prepare("INSERT INTO img_seen (sha, stored_at, seen_at) VALUES (?, ?, ?)").run(sha(2), old.toISOString(), new Date(Date.now() - 7 * 86400e3).toISOString());
  for (const w of [1600, 1080]) r2.set(`imgv/${sha(3)}-${w}`, { buf: new Uint8Array(9), ct: "image/webp", uploaded: old });   // sizes only, last shown 100 days ago: go
  sq.prepare("INSERT INTO img_seen (sha, stored_at, seen_at) VALUES (?, ?, ?)").run(sha(3), old.toISOString(), new Date(Date.now() - 100 * 86400e3).toISOString());
  sq.prepare("INSERT INTO img_work (key, bytes, state, at) VALUES (?, 1, 'done', ?)").run("img/" + sha(3), old.toISOString());
  const r = await m.sweepImgs(env, { pages: 1 });
  check(r.listing === "done" && r.backfilled >= 2, `the listing gives the older pictures their rows and ends (${r.backfilled} rows, ${r.listing})`);
  check(!r2.has("img/" + sha(1)) && r2.has("img/" + sha(2)) && !r2.has(`imgv/${sha(3)}-1600`) && !r2.has(`imgv/${sha(3)}-1080`),
    `never shown in 90 days goes, original and sizes; shown last week stays (${["img/" + sha(1), "img/" + sha(2), `imgv/${sha(3)}-1600`].map((k) => r2.has(k)).join(", ")})`);
  check(!sq.prepare("SELECT 1 FROM img_seen WHERE sha = ?").get(sha(3)) && !sq.prepare("SELECT 1 FROM img_work WHERE key = ?").get("img/" + sha(3)) && r.swept === 2, `its rows go too, so a later open fetches and shrinks it again (${r.swept} swept)`);
  const c = sq.prepare("SELECT value FROM prefs WHERE key = 'imgsweep:cursor'").get();
  const prefs = await (await m.default.fetch(new Request("https://hub.example/api/prefs", { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} })).json();
  check(c?.value === '"done"' && !("imgsweep:cursor" in (prefs.prefs || {})), `the cursor is kept, "done", and never sent to the apps (${c?.value})`);
  const r2nd = await m.sweepImgs(env); check(r2nd.listed === 0 && r2nd.swept === 0, `the next day lists nothing and sweeps nothing new (${r2nd.listed}, ${r2nd.swept})`);
}
// 6. security review 2026-11-13
// P2: a held picture that comes in again with new mail starts its 90 days again, so the sweep keeps it and the new mail's open never asks
// its sender (a picture stored 100 days ago and never shown was swept, and the new mail's open fetched it from the sender).
{
  const u = IMG("/old-logo.png"), s = shaOf(u), old = new Date(Date.now() - 100 * 86400e3);
  r2.set("img/" + s, { buf: SMALL, ct: "image/png", uploaded: old });
  sq.prepare("INSERT OR REPLACE INTO img_seen (sha, stored_at, seen_at) VALUES (?, ?, NULL)").run(s, old.toISOString());
  const n0 = sender.length, a = await m.prefetchImages(env, `<img src="${u}" width="40" height="30">`, "test", { left: { images: 99, bytes: 1e9 }, from: "news@sender.example" });
  const sw = await m.sweepImgs(env, { pages: 1 }); edge.clear();
  const o = await open(u, "&w=1600");
  check(a.had === 1 && r2.has("img/" + s) && o.status === 200 && o.source !== "upstream" && sender.length === n0,
    `a picture stored 100 days ago that comes in again with new mail is kept by the sweep, and the new mail's open asks no sender (had ${a.had}, swept ${sw.swept}, ${o.source}, ${sender.length - n0} asked)`);
}
// P3: a picture fetched from its sender at an open and kept nowhere (the day's allowance spent) is cached on the device 30 days, so a re-open
// does not ask the sender again (it was 5 minutes since the sizes).
{
  const ev = sq.prepare("INSERT INTO events (kind, detail) VALUES ('img_prefetch', 'test stored=5000 bytes=999999999999')").run();
  const n0 = sender.length, o = await open(IMG("/unkept.png"), "&w=1600");
  sq.prepare("DELETE FROM events WHERE id = ?").run(ev.lastInsertRowid);
  check(o.status === 200 && o.source === "upstream" && sender.length === n0 + 1 && o.cc === "private, max-age=2592000, immutable" && !r2.has("img/" + shaOf(IMG("/unkept.png"))),
    `a picture fetched at an open past the day's allowance, kept nowhere, is cached on the device 30 days (${o.source}, ${o.cc})`);
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
