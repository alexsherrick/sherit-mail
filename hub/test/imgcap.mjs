#!/usr/bin/env node
// The image proxy's size cap. A newsletter picture did not show: a shop's hero GIF on
// Klaviyo's CDN is 8,538,982 bytes, and /api/img refused everything over 8 MiB with 413 "too large". The real Worker runs against a
// fake upstream serving an image of exactly that size; the same checks against HEAD 684a7e5's Worker must fail where the cap was.
// Checks that:
//  - an opened image up to 16 MiB is served, with or without a declared length, and kept in R2;
//  - one over 16 MiB is refused (declared: 413; undeclared: the stream errors and nothing is kept);
//  - arrival prefetch still refuses an image over 8 MiB and keeps a small one.
// Usage: node test/imgcap.mjs (exit 1 on any failed check)
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
      bind: (...a) => mk(a),
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => Promise.all(xs.map((x) => x.run())),
});

// ---------- the real Worker (Cloudflare-only imports stubbed, as test/delta.mjs does) ----------
const stub = (src) => src
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
async function loadWorker(tag, src) {
  const tmp = `${HUB}test/_imgcap_${tag}.mjs`;
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

// ---------- the fake sender: Klaviyo's CDN, with images of chosen sizes ----------
const HERO_GIF = 8538982;                       // the hero GIF's size, curl 2026-10-15
const MIB = 1024 * 1024;
const gif = (n) => { const b = new Uint8Array(n); b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]); return b; };
const SIZES = { "/hero.gif": HERO_GIF, "/hero2.gif": HERO_GIF, "/big.gif": 16 * MIB + 1, "/small.gif": 300_000, "/cap.gif": 16 * MIB };
const realFetch = globalThis.fetch;
let upstream = 0;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
  upstream++;
  const n = SIZES[u.pathname]; if (!n) return new Response("nope", { status: 404 });
  const body = gif(n);
  // ?undeclared: no content-length, so only the streamed count can stop it
  // ?slow: a sender that streams over ~1 s, so two opens are really in flight together
  if (u.searchParams.has("slow")) return new Response(new ReadableStream({ async start(c) { for (let i = 0; i < body.length; i += 262144) { c.enqueue(body.subarray(i, i + 262144)); await new Promise((r) => setTimeout(r, 30)); } c.close(); } }), { headers: { "content-type": "image/gif", "content-length": String(n) } });
  if (u.searchParams.has("undeclared")) return new Response(new ReadableStream({ start(c) { for (let i = 0; i < body.length; i += 65536) c.enqueue(body.subarray(i, i + 65536)); c.close(); } }), { headers: { "content-type": "image/gif" } });
  return new Response(body, { headers: { "content-type": "image/gif", "content-length": String(n) } });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

async function scenario(mod) {
  const r2 = new Map();
  const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k) => (r2.has(k) ? { body: new Response(r2.get(k).buf).body, httpMetadata: { contentType: r2.get(k).ct } } : null), put: async (k, buf, o) => { r2.set(k, { buf, ct: o?.httpMetadata?.contentType }); } };
  const env = { DB: d1(buildDb()), STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const call = (path, ctx = { waitUntil: () => {} }) => mod.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE } }), env, ctx);
  const key = (await (await call("/api/me")).json()).img_key;
  const open = async (path) => {
    const waits = []; const res = await call("/api/img?u=" + encodeURIComponent("https://cdn.klaviyomail.com" + path) + "&k=" + key, { waitUntil: (p) => waits.push(p) });
    let len = null, err = null; try { len = (await res.arrayBuffer()).byteLength; } catch (e) { err = String(e?.message || e); }
    await Promise.allSettled(waits);
    return { status: res.status, len, err, source: res.headers.get("x-img-source") };
  };
  const out = {};
  out.hero = await open("/hero.gif");
  out.heroUndeclared = await open("/hero.gif?undeclared");
  out.cap = await open("/cap.gif");
  const before = r2.size;
  out.big = await open("/big.gif");
  out.bigUndeclared = await open("/big.gif?undeclared");
  out.keptOver = r2.size - before;
  out.keptHero = r2.size;
  // arrival prefetch: a fresh R2, the hero GIF and a small one
  r2.clear();
  out.pre = await mod.prefetchImages(env, '<img src="https://cdn.klaviyomail.com/hero.gif" width="600" height="600"><img src="https://cdn.klaviyomail.com/small.gif" width="60" height="60">', "test", { left: { images: 99, bytes: 1e9 } });
  out.preKept = r2.size;
  return out;
}

const mod = await loadWorker("fixed", readFileSync(HUB + "src/index.js", "utf8"));
const s = await scenario(mod);
console.log(JSON.stringify(s));
check(s.hero.status === 200 && s.hero.len === HERO_GIF && s.hero.source === "upstream", `the shop's ${HERO_GIF}-byte GIF is served whole (${s.hero.status}, ${s.hero.len} bytes)`);
check(s.heroUndeclared.status === 200 && s.heroUndeclared.len === HERO_GIF, `and whole when the sender declares no length (${s.heroUndeclared.status}, ${s.heroUndeclared.len} bytes${s.heroUndeclared.err ? ", " + s.heroUndeclared.err : ""})`);
check(s.cap.status === 200 && s.cap.len === 16 * MIB, `an image of exactly 16 MiB is served (${s.cap.status}, ${s.cap.len})`);
check(s.big.status === 413, `one byte over 16 MiB, declared, is refused 413 (${s.big.status})`);
check(s.bigUndeclared.err !== null || s.bigUndeclared.status !== 200, `one byte over 16 MiB, undeclared, errors in the stream (${s.bigUndeclared.status}, ${s.bigUndeclared.err})`);
check(s.keptOver === 0, `nothing over 16 MiB is kept in R2 (${s.keptOver} kept)`);
check(s.keptHero >= 1, `the GIF opened is kept in R2 for later opens (${s.keptHero} in R2)`);
check(s.pre.stored === 1 && s.pre.failed === 1 && s.preKept === 1, `arrival prefetch keeps the small image and still refuses the 8.14 MiB GIF (${JSON.stringify(s.pre)})`);

// ---------- open-time keeping is bounded ----------
// Each case loads a fresh Worker: the day allowance is read at most once a minute per isolate.
async function bounded(src, tag) {
  const r2 = new Map(), sq = buildDb();
  const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k) => (r2.has(k) ? { body: new Response(r2.get(k).buf).body, httpMetadata: { contentType: r2.get(k).ct } } : null), put: async (k, buf, o) => { r2.set(k, { buf, ct: o?.httpMetadata?.contentType }); } };
  const m = await loadWorker(tag, src), env = { DB: d1(sq), STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const call = (path, ctx) => m.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE } }), env, ctx);
  const key = (await (await call("/api/me", { waitUntil: () => {} })).json()).img_key, u = (p) => "/api/img?u=" + encodeURIComponent("https://cdn.klaviyomail.com" + p) + "&k=" + key;
  return { m, env, sq, r2, call, u };
}
const count = (sq, t, where = "") => sq.prepare(`SELECT COUNT(*) n FROM ${t} ${where}`).get().n;
async function concurrentBig(src, tag) {
  const b = await bounded(src, tag), waits = [];
  const [x, y] = await Promise.all(["/hero.gif?slow", "/hero2.gif?slow"].map((p) => b.call(b.u(p), { waitUntil: (w) => waits.push(w) })));
  const lx = (await x.arrayBuffer()).byteLength, ly = (await y.arrayBuffer()).byteLength; await Promise.allSettled(waits);
  return { lx, ly, kept: b.r2.size };
}
async function fullDay(src, tag) {
  const b = await bounded(src, tag);
  b.sq.prepare("INSERT INTO events (kind, detail) VALUES ('img_prefetch', ?)").run(`test n=1 stored=1 had=0 failed=0 bytes=${250 * MIB}`);
  const waits = [], res = await b.call(b.u("/small.gif"), { waitUntil: (w) => waits.push(w) }); const len = (await res.arrayBuffer()).byteLength; await Promise.allSettled(waits);
  return { status: res.status, len, kept: b.r2.size, dims: count(b.sq, "img_dims"), events: count(b.sq, "events", "WHERE kind = 'img_open_kept'") };
}
async function counted(src, tag) {
  const b = await bounded(src, tag), waits = [];
  const res = await b.call(b.u("/small.gif"), { waitUntil: (w) => waits.push(w) }); await res.arrayBuffer(); await Promise.allSettled(waits);
  return { kept: b.r2.size, events: count(b.sq, "events", "WHERE kind = 'img_open_kept'"), left: b.m.prefetchAllowance ? (await b.m.prefetchAllowance(b.env)).bytes : null };
}
const SRC_NOW = readFileSync(HUB + "src/index.js", "utf8");
const cb = await concurrentBig(SRC_NOW, "cb");
check(cb.lx === HERO_GIF && cb.ly === HERO_GIF && cb.kept === 1, `two 8.5 MB pictures opened at once are both served whole, and only one is kept (${cb.lx}, ${cb.ly}, ${cb.kept} kept)`);
const fd = await fullDay(SRC_NOW, "fd");
check(fd.status === 200 && fd.len === 300_000 && fd.kept === 0 && fd.dims === 0 && fd.events === 0, `with the day allowance used up a picture is served but not kept, sized or counted (${JSON.stringify(fd)})`);
const ct = await counted(SRC_NOW, "ct");
check(ct.kept === 1 && ct.events === 1 && ct.left === 250 * MIB - 300_000, `a picture kept at open is counted against the day allowance it shares with prefetch (${JSON.stringify(ct)})`);
if (gitHas("fa41ffa")) try {
  const OLD = execSync("git show fa41ffa:hub/src/index.js", { cwd: HUB, encoding: "utf8", maxBuffer: 64 * MIB });   // the 16 MiB cap, before the bounds
  const ocb = await concurrentBig(OLD, "ocb"), ofd = await fullDay(OLD, "ofd");
  check(ocb.kept === 2 && ofd.kept === 1, `CONTROL: fa41ffa keeps both concurrent big pictures (${ocb.kept}) and keeps past a full day (${ofd.kept})`);
} catch (e) { check(false, "bounded control could not run: " + e.message); }

// ---------- CONTROL: HEAD 684a7e5's Worker must fail where the cap was ----------
let old = null;
if (gitHas("684a7e5")) try { old = await scenario(await loadWorker("control", execSync("git show 684a7e5:hub/src/index.js", { cwd: HUB, encoding: "utf8", maxBuffer: 64 * MIB }))); } catch (e) { check(false, "control could not run: " + e.message); }
if (old) check(old.hero.status === 413 && old.cap.status === 413, `CONTROL: the Worker before the fix refuses the GIF as the user saw (${old.hero.status}, 16 MiB ${old.cap.status})`);

globalThis.fetch = realFetch;
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
