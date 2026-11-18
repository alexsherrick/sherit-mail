#!/usr/bin/env node
// Picture sizes. A mail grew in steps as its pictures loaded. The hub measures each picture it
// keeps so the app can hold its box before it arrives. Real Worker, real migrations, real SQLite, a fake R2 and a fake sender. Checks:
//  - imgSize reads PNG, GIF, WebP (VP8, VP8L, VP8X), JPEG (EXIF orientation turns it), AVIF (largest ispe, irot), and refuses junk;
//  - urlHash is the same function in index.js and client/app.js, so the app finds the rows the hub writes;
//  - arrival prefetch, a first open through /api/img, and a picture kept before sizes existed all leave one row each;
//  - GET /api/imgdims returns them by day and then nothing new; HEAD 684a7e5's Worker writes no rows and has no route (CONTROL).
// Usage: node test/imgdims.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process"; const gitHas = (sha) => { try { execSync(`git cat-file -e ${sha}^{commit}`, { cwd: HUB, stdio: "ignore" }); return true; } catch (_) { console.log(`SKIP control: ${sha} is not in this checkout`); return false; } };

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); return c; };
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
function buildDb() {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of statements(sql)) { try { sq.exec(stmt); } catch (_) {} }
  }
  return sq;
}
const d1 = (sq) => ({
  prepare(sql) {
    const mk = (params) => ({
      bind: (...a) => { if (a.length > 100) throw new Error("D1_ERROR: too many SQL variables"); return mk(a); },
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; },
});
const stub = (src) => src
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
async function loadWorker(tag, src) {
  const tmp = `${HUB}test/_imgdims_${tag}.mjs`;
  writeFileSync(tmp, stub(src));
  try { return await import(tmp); } finally { unlinkSync(tmp); }
}
const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
};
const exp = Date.now() + 86400000;
const COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;

// ---------- headers, built by hand from each format's layout ----------
const cat = (...parts) => { const a = parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : [...p])); return new Uint8Array(a); };
const be32 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], be16 = (n) => [n >>> 8, n & 255], le16 = (n) => [n & 255, n >>> 8], le24 = (n) => [n & 255, (n >>> 8) & 255, n >>> 16];
const pad = (u, n = 64) => { const o = new Uint8Array(Math.max(n, u.length)); o.set(u); return o; };
const png = (w, h) => pad(cat([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]));
const gif = (w, h) => pad(cat("GIF89a", le16(w), le16(h), [0xf7, 0, 0]));
const vp8x = (w, h) => pad(cat("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0x10, 0, 0, 0], le24(w - 1), le24(h - 1)));
const vp8l = (w, h) => { const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14); return pad(cat("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])); };
const vp8 = (w, h) => pad(cat("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0x50, 0x2a, 0x00], [0x9d, 0x01, 0x2a], le16(w), le16(h)));
const exif = (orient, mm) => { const r16 = mm ? be16 : le16, r32 = mm ? be32 : (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
  const tiff = cat(mm ? "MM" : "II", r16(42), r32(8), r16(1), r16(0x0112), r16(3), r32(1), r16(orient), [0, 0], [0, 0, 0, 0]);
  return cat([0xff, 0xe1], be16(2 + 6 + tiff.length), "Exif\0\0", tiff); };
const jpeg = (w, h, app1 = []) => pad(cat([0xff, 0xd8], [0xff, 0xe0], be16(16), "JFIF\0", [1, 1, 0], be16(72), be16(72), [0, 0], app1, [0xff, 0xc2], be16(17), [8], be16(h), be16(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xda]));
const box = (type, body) => cat(be32(8 + body.length), type, body);
const avif = (rot) => pad(cat(box("ftyp", cat("avif", be32(0), "mif1")), box("meta", cat(be32(0), box("iprp", box("ipco", cat(
  box("ispe", cat(be32(0), be32(512), be32(512))), box("ispe", cat(be32(0), be32(1024), be32(768))), rot == null ? [] : box("irot", new Uint8Array([rot])))))))));

const mod = await loadWorker("fixed", readFileSync(HUB + "src/index.js", "utf8"));
const S = mod.imgSize;
const eq = (r, w, h) => r && r.w === w && r.h === h;
check(eq(S(png(979, 1143)), 979, 1143), "PNG: IHDR 979 × 1143");
check(eq(S(gif(979, 1143)), 979, 1143), "GIF: logical screen 979 × 1143");
check(eq(S(vp8x(1200, 628)), 1200, 628) && eq(S(vp8l(300, 250)), 300, 250) && eq(S(vp8(640, 480)), 640, 480), "WebP: VP8X 1200 × 628, VP8L 300 × 250, VP8 640 × 480");
check(eq(S(jpeg(6016, 4016)), 6016, 4016), "JPEG: the frame header (progressive SOF2) 6016 × 4016");
check(eq(S(jpeg(4000, 3000, exif(6))), 3000, 4000) && eq(S(jpeg(4000, 3000, exif(8, true))), 3000, 4000), "JPEG with EXIF orientation 6 (II) and 8 (MM) is turned: 3000 × 4000");
check(eq(S(jpeg(4000, 3000, exif(1))), 4000, 3000) && eq(S(jpeg(4000, 3000, exif(3, true))), 4000, 3000), "JPEG with orientation 1 or 3 keeps 4000 × 3000");
check(eq(S(avif()), 1024, 768) && eq(S(avif(1)), 768, 1024) && eq(S(avif(2)), 1024, 768), "AVIF: the largest ispe (1024 × 768, not the 512 tile), turned by irot 1, not by irot 2");
check(S(new Uint8Array(64)) === null && S(cat("GIF89a")) === null && S(pad(cat([0xff, 0xd8, 0xff, 0xda]))) === null && S(png(0, 10)) === null, "junk, a truncated header, scan data before a frame, a zero side: null");

// ---------- one hash on both sides ----------
const APP = readFileSync(HUB + "src/client/app.js", "utf8"), WRK = readFileSync(HUB + "src/index.js", "utf8");
const fnOf = (t) => (t.match(/^function urlHash\(s\) \{.*\}$/m) || [null])[0];
check(fnOf(APP) && fnOf(APP) === fnOf(WRK), "urlHash in client/app.js is index.js's, character for character");
const urlHash = new Function(fnOf(APP) + "\nreturn urlHash;")();
const hA = urlHash("https://cdn.klaviyomail.com/company/AbCdEf/images/00000000-0000-4000-8000-000000000001.gif"), hB = urlHash("https://cdn.klaviyomail.com/company/AbCdEf/images/00000000-0000-4000-8000-000000000001.gif?");
check(Number.isSafeInteger(hA) && hA > 2 ** 40 && hA !== hB, `the hash is a safe integer of up to 53 bits and tells near-identical URLs apart (${hA}, ${hB})`);

// ---------- the Worker: rows at arrival, at first open, for a picture kept before sizes; the sync route ----------
const IMGS = { "/hero.gif": gif(979, 1143), "/logo.png": png(240, 60), "/new.webp": vp8x(1200, 628), "/old.png": png(600, 200) };
const realFetch = globalThis.fetch;
let upstream = 0;
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
  upstream++; const b = IMGS[u.pathname]; if (!b) return new Response("nope", { status: 404 });
  const ct = u.pathname.endsWith(".gif") ? "image/gif" : u.pathname.endsWith(".webp") ? "image/webp" : "image/png";
  return new Response(b, { headers: { "content-type": ct, "content-length": String(b.length) } });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

async function scenario(m) {
  const sq = buildDb(), DB = d1(sq), r2 = new Map(); let rangeReads = 0;
  const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null),
    get: async (k, o) => { if (!r2.has(k)) return null; const full = r2.get(k).buf; const part = o?.range ? (rangeReads++, full.slice(o.range.offset, o.range.offset + o.range.length)) : full;
      return { body: new Response(part).body, arrayBuffer: async () => part, httpMetadata: { contentType: r2.get(k).ct } }; },
    put: async (k, buf, o) => { r2.set(k, { buf: new Uint8Array(buf).slice().buffer, ct: o?.httpMetadata?.contentType }); } };
  const env = { DB, STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const call = (path, ctx = { waitUntil: () => {} }) => m.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE } }), env, ctx);
  const key = (await (await call("/api/me")).json()).img_key;
  const rows = () => sq.prepare("SELECT hk, w, h FROM img_dims ORDER BY seq").all();
  const out = {};
  // a picture kept in R2 before sizes existed: the stored copy is all there is
  const sha = async (s) => "img/" + Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
  r2.set(await sha("https://cdn.ex.com/old.png"), { buf: IMGS["/old.png"].slice().buffer, ct: "image/png" });
  const html = '<img src="https://cdn.ex.com/hero.gif" width="600"><img src="https://cdn.ex.com/logo.png"><img src="https://cdn.ex.com/old.png" width="300">';
  out.pre = await m.prefetchImages(env, html, "test", { left: { images: 99, bytes: 1e9 } });
  out.afterArrival = rows(); out.rangeReads = rangeReads;
  upstream = 0; rangeReads = 0;
  out.again = await m.prefetchImages(env, html, "test", { left: { images: 99, bytes: 1e9 } });
  out.againRows = rows().length; out.againUp = upstream; out.againRange = rangeReads;
  // a first open of a picture nothing fetched at arrival
  const waits = []; const res = await call("/api/img?u=" + encodeURIComponent("https://cdn.ex.com/new.webp") + "&k=" + key, { waitUntil: (p) => waits.push(p) });
  await res.arrayBuffer(); await Promise.allSettled(waits);
  out.afterOpen = rows();
  const s0 = await call("/api/imgdims?since=0"); out.sync0 = { status: s0.status, body: s0.status === 200 ? await s0.json() : null };
  const s1 = out.sync0.body ? await call("/api/imgdims?since=" + out.sync0.body.seq) : null; out.sync1 = s1 ? await s1.json() : null;
  return out;
}
const s = await scenario(mod);
const byHash = (list, u) => list.find((x) => x.hk === urlHash(new URL(u).href));
const has = (list, u, w, h) => { const x = byHash(list, u); return !!x && x.w === w && x.h === h; };
check(s.pre.stored === 2 && s.pre.had === 1 && s.pre.sized === 3, `arrival: two pictures fetched and kept, one already held, three sized (${JSON.stringify(s.pre)})`);
check(has(s.afterArrival, "https://cdn.ex.com/hero.gif", 979, 1143) && has(s.afterArrival, "https://cdn.ex.com/logo.png", 240, 60), "the rows carry each picture's real size, under the hash the app computes from the URL");
check(has(s.afterArrival, "https://cdn.ex.com/old.png", 600, 200) && s.rangeReads === 1, `a picture kept before sizes existed is measured from the head of its stored copy (${s.rangeReads} range read)`);
check(s.again.had === 3 && s.againRows === 3 && s.againUp === 0 && s.againRange === 0, `a second arrival of the same pictures fetches nothing and reads nothing (${s.againUp} upstream, ${s.againRange} range reads, ${s.againRows} rows)`);
check(has(s.afterOpen, "https://cdn.ex.com/new.webp", 1200, 628), "a picture first fetched at open is sized too");
const days = s.sync0.body?.days || {}; const all = Object.values(days).flat();
check(s.sync0.status === 200 && all.length === 4 && Object.keys(days).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), `GET /api/imgdims?since=0 returns the four rows by day (${s.sync0.status}, ${all.length} rows, days ${Object.keys(days)})`);
check(all.some(([k, w, h]) => k === urlHash("https://cdn.ex.com/hero.gif") && w === 979 && h === 1143), "a synced row is [hash, width, height]");
check(s.sync1 && Object.keys(s.sync1.days).length === 0 && s.sync1.seq === s.sync0.body.seq && s.sync1.more === false, `asking again from the returned seq brings nothing new (${JSON.stringify(s.sync1)})`);

// ---------- a picture whose size cannot be read is marked once, not re-read, and never synced ----------
{
  IMGS["/odd.png"] = pad(cat([0x89], "PNG\r\n\x1a\n", be32(13), "XXXX", be32(5), be32(5)));   // a PNG's magic, then no IHDR
  const sq = buildDb(), DB = d1(sq), r2 = new Map(); let rangeReads = 0;
  const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k, o) => { if (!r2.has(k)) return null; if (o?.range) rangeReads++; const b = r2.get(k).buf; return { body: new Response(b).body, arrayBuffer: async () => b, httpMetadata: { contentType: "image/png" } }; }, put: async (k, buf) => { r2.set(k, { buf: new Uint8Array(buf).slice().buffer }); } };
  const env = { DB, STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const html = '<img src="https://cdn.ex.com/odd.png" width="40">';
  await mod.prefetchImages(env, html, "test", { left: { images: 99, bytes: 1e9 } }); await mod.prefetchImages(env, html, "test", { left: { images: 99, bytes: 1e9 } });
  const row = sq.prepare("SELECT w, h FROM img_dims").all();
  const call = (path) => mod.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} });
  const sync = await (await call("/api/imgdims?since=0")).json();
  check(row.length === 1 && row[0].w === 0 && row[0].h === 0 && rangeReads === 0, `an unreadable picture gets one 0 x 0 row and is not read again on its next arrival (${JSON.stringify(row)}, ${rangeReads} range reads)`);
  check(Object.keys(sync.days).length === 0 && sync.seq >= 1, `the sync skips it but moves past it (${JSON.stringify(sync)})`);
}

// ---------- CONTROL: the Worker before this change ----------
let old = null;
if (gitHas("684a7e5")) try { old = await scenario(await loadWorker("control", execSync("git show 684a7e5:hub/src/index.js", { cwd: HUB, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))); } catch (e) { check(false, "control could not run: " + e.message); }
if (old) check(old.afterArrival.length === 0 && old.afterOpen.length === 0 && old.sync0.status !== 200, `CONTROL: HEAD 684a7e5 keeps no sizes and has no sync route (${old.afterArrival.length} rows, /api/imgdims ${old.sync0.status})`);

globalThis.fetch = realFetch;
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
