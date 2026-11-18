#!/usr/bin/env node
// Picture shrinking. Built in-house rather than bought: the hub's big pictures are shrunk by
// our own sharp code in a Cloudflare Container that runs only while pictures wait. Checks, end to end without Docker:
//  1. the container's server (hub/shrink/container/server.js, real sharp): a camera photo turned upright and narrowed to 1600 px, an
//  animation keeping every frame, transparency kept, junk and oversize refused;
//  2. the shrink Worker (hub/shrink/src/index.js) on real migrations and SQLite, its container replaced by a stand-in that forwards to
//  that server: nothing waiting starts nothing; a batch replaces a picture only when the WebP is under 80 %, skips the rest, leaves a
//  picture the container refuses as sent on the first try, retries any other failure three times, stops the container
//  once and books its running time; past the month's 5 hours nothing starts; a failed run fails the scheduled event instead of reading
//  as a success. SHRINK_WORKER_SRC runs part 2 against another copy of the Worker (the pre-fix code).
//  A container that ignores SIGTERM is destroyed within the stop wait; an instance found running on an idle tick (one a
//  rollout started) is ended and booked the whole time since the object last saw its container down; the idle timeout ends it the same
//  way and never a batch in progress; a start that fails after the process launched still ends and books it; a stop that hangs, a kill
//  that fails and a booking that fails are errors on the run and fail the scheduled event; the server
//  itself exits on SIGTERM with code 0 (as PID 1 in the container only a handler of its own can end it), where 92c22a4's dies only by
//  the signal's default action (CONTROL);
//  3. the hub (index.js) queues pictures of 500 KB or more (or wider than 1080 px, or a PNG from 20 KB) at arrival and at first open,
//  now into img_work for the mailhub-img Worker, not smaller ones, notes every kept picture in img_seen, and the
//  daily report carries the line; HEAD 684a7e5's hub queues nothing (CONTROL).
// Usage: node test/shrink.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync, spawn } from "node:child_process"; const gitHas = (sha) => { try { execSync(`git cat-file -e ${sha}^{commit}`, { cwd: HUB, stdio: "ignore" }); return true; } catch (_) { console.log(`SKIP control: ${sha} is not in this checkout`); return false; } };
import { createRequire } from "node:module";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); return c; };
const sharp = createRequire(HUB + "shrink/container/package.json")("sharp");
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
// Comments removed outside quotes (a "--" can sit at the end of a line), as test/addrlock.mjs does: a migration whose statement kept a
// trailing comment would otherwise fail and drop its table.
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) for (const stmt of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(stmt); } catch (_) {} }
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
  batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; },
});
const r2 = () => { const m = new Map(); return { _m: m,
  head: async (k) => (m.has(k) ? { key: k } : null),
  get: async (k, o) => { if (!m.has(k)) return null; const v = m.get(k); const b = o?.range ? v.buf.slice(o.range.offset, o.range.offset + o.range.length) : v.buf;
    return { body: new Response(b).body, arrayBuffer: async () => b, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata }; },
  put: async (k, buf, o = {}) => { m.set(k, { buf: new Uint8Array(buf).slice().buffer, httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {} }); } }; };

// ---------- pictures, made with sharp ----------
const noise = (w, h, ch = 3) => { const b = Buffer.alloc(w * h * ch); for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761 >>> 24) ^ (i & 255); return sharp(b, { raw: { width: w, height: h, channels: ch } }); };
const photo = await noise(3000, 2000).jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toBuffer();       // shown 2000 x 3000
const bigPng = await noise(1400, 1000).png().toBuffer();
const alphaPng = await noise(800, 600, 4).png().toBuffer();
const frames = await Promise.all(Array.from({ length: 6 }, (_, i) => sharp({ create: { width: 979, height: 1143, channels: 3, background: { r: 40 * i, g: 90, b: 200 - 30 * i } } }).png().toBuffer()));
const anim = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
const smallWebp = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#3a6" } }).webp({ quality: 60 }).toBuffer();

// ---------- 1. the container's server ----------
const port = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [HUB + "shrink/container/server.js"], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/")).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
const post = (buf, q = "") => fetch(base + "/shrink" + q, { method: "POST", body: buf });
const info = async (res) => { const b = Buffer.from(await res.arrayBuffer()); const m = await sharp(b, { animated: true }).metadata(); return { b, m }; };
try {
  const p = await info(await post(photo));
  check(p.m.format === "webp" && p.m.width === 1600 && p.m.height === 2400 && !p.m.orientation, `a 3000 × 2000 photo with EXIF orientation 6 comes back upright as WebP, 1600 wide (${p.m.format} ${p.m.width} × ${p.m.height}, ${photo.length} -> ${p.b.length} B)`);
  const a = await info(await post(anim));
  check(a.m.format === "webp" && a.m.pages === 6 && a.m.width === 979 && a.m.pageHeight === 1143, `an animation keeps all its frames and is never enlarged (${a.m.pages} frames, ${a.m.width} × ${a.m.pageHeight})`);
  const t = await info(await post(alphaPng));
  check(t.m.hasAlpha === true && t.m.width === 800, `transparency is kept (${t.m.hasAlpha})`);
  const junk = await post(Buffer.from("this is not a picture at all"));
  const huge = await post(Buffer.alloc(21 * 1024 * 1024));
  check(junk.status === 422 && huge.status === 413, `junk is refused 422 and more than 20 MB 413 (${junk.status}, ${huge.status})`);
  // every frame distinct: sharp's GIF encoder merges near-identical frames (a solid-colour run of 601 came out as 76)
  const tiles = await Promise.all(Array.from({ length: 601 }, (_, i) => { const px = Buffer.alloc(8 * 8 * 3); for (let j = 0; j < px.length; j++) px[j] = (i * 37 + j * 11) & 255; return sharp(px, { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer(); }));
  const many = await sharp(tiles, { join: { animated: true } }).gif().toBuffer();
  const frames601 = (await sharp(many, { animated: true }).metadata()).pages, tooMany = await post(many);
  check(frames601 === 601 && tooMany.status === 422 && /refused: 601 frames/.test(await tooMany.text()), `an animation of 601 frames is refused from its header before decoding (${frames601} frames, ${tooMany.status})`);
} catch (e) { check(false, "server checks threw: " + e.message); }

// ---------- 2. the shrink Worker ----------
const stubbed = readFileSync(process.env.SHRINK_WORKER_SRC || HUB + "shrink/src/index.js", "utf8").replace(/^import \{ Container, getContainer \} from "@cloudflare\/containers";$/m,
  `class Container { constructor(env) { this.env = env; this.starts = 0; this.stops = 0; this.destroys = 0; this.obeys = true; this.container = { running: false }; this.store = new Map();
       this.ctx = { storage: { get: async (k) => this.store.get(k), put: async (k, v) => { this.store.set(k, v); } } }; }
     async startAndWaitForPorts() { this.starts++; this.container.running = true; if (this.startFails) throw new Error("port 8080 never answered"); }
     async stop() { this.stops++; if (this.stopHangs) return new Promise(() => {}); if (this.obeys) this.container.running = false; }
     async destroy() { this.destroys++; if (this.destroyFails) throw new Error("destroy refused"); this.container.running = false; }
     async containerFetch(url, init) { const u = new URL(url); return fetch("${base}" + u.pathname + u.search, init); } }
   const getContainer = (ns) => ns.get();`);
const tmp = `${HUB}test/_shrink_worker.mjs`; writeFileSync(tmp, stubbed);
const W = await import(tmp).finally(() => unlinkSync(tmp));
{
  const sq = buildDb(), STORE = r2(); let inst = null;
  const env = { DB: d1(sq), STORE }; env.SHRINKER = { get: () => (inst ||= new W.Shrinker(env)) };
  const idle = await W.tick(env);
  // The idle tick asks the object whether an instance is running (so a stray one is ended) but starts nothing
  check(idle.idle === true && idle.running === false && inst.starts === 0, `nothing waiting: the cron starts no container, and asks the object whether one is running (${JSON.stringify(idle)})`);
  const put = (k, buf, ct) => STORE.put(k, buf, { httpMetadata: { contentType: ct }, customMetadata: { at: "2026-10-15T00:00:00Z", via: "arrival" } });
  await put("img/big", bigPng, "image/png"); await put("img/photo", photo, "image/jpeg"); await put("img/small", smallWebp, "image/webp"); await put("img/junk", Buffer.from("not a picture, but stored"), "image/png");
  const q = sq.prepare("INSERT INTO img_shrink (key, bytes, ct, state, at) VALUES (?, ?, ?, 'pending', ?)");
  q.run("img/big", bigPng.length, "image/png", "2026-10-15T01:00:00Z"); q.run("img/photo", photo.length, "image/jpeg", "2026-10-15T02:00:00Z");
  q.run("img/small", smallWebp.length, "image/webp", "2026-10-15T03:00:00Z"); q.run("img/gone", 900000, "image/png", "2026-10-15T04:00:00Z"); q.run("img/junk", 600000, "image/png", "2026-10-15T05:00:00Z");
  const r = await W.tick(env);
  const row = (k) => sq.prepare("SELECT state, out_bytes, tries, note FROM img_shrink WHERE key = ?").get(k);
  const big = STORE._m.get("img/big"), ph = STORE._m.get("img/photo"), sm = STORE._m.get("img/small");
  check(r.done === 2 && row("img/big").state === "done" && row("img/photo").state === "done", `a batch shrinks the two that can be (${JSON.stringify(r)})`);
  check(big.httpMetadata.contentType === "image/webp" && big.customMetadata.shrunk && big.customMetadata.from === String(bigPng.length) && big.customMetadata.via === "arrival" && big.buf.byteLength < bigPng.length * 0.8,
    `the stored copy becomes the WebP under the same key, with what it was and when (${bigPng.length} -> ${big.buf.byteLength} B)`);
  check((await sharp(Buffer.from(ph.buf)).metadata()).width === 1600, "the photo is stored upright at 1600 px wide");
  check(row("img/small").state === "skipped" && sm.httpMetadata.contentType === "image/webp" && sm.buf.byteLength === smallWebp.length, `a result not under 80 % leaves the original in place (${row("img/small").note})`);
  check(row("img/gone").state === "skipped" && /no stored copy/.test(row("img/gone").note), "a row whose picture is gone is skipped");
  // Four GIFs over sharp's pixel ceiling went back to the queue twice each for the same 422
  check(row("img/junk").state === "skipped" && row("img/junk").tries === 1 && /^422 /.test(row("img/junk").note || ""), `a picture the container refuses (422) is left as sent on the first try, with its answer (${JSON.stringify(row("img/junk"))})`);
  check(inst.starts === 1 && inst.stops === 1 && inst.destroys === 0 && !inst.container.running && r.stop?.signalled === true && r.stop?.destroyed === false,
    `the container is started once, stopped as the batch ends, and seen down without a kill (${inst.starts} starts, ${inst.stops} stops, ${inst.destroys} kills, ${JSON.stringify(r.stop)})`);
  const run = sq.prepare("SELECT seconds, runs FROM shrink_runs").get();
  check(run && run.runs === 1 && run.seconds >= 0, `its running time is booked for the month (${JSON.stringify(run)})`);
  // any other error is the container's, not the picture's: tried again, and marked failed after three tries
  await put("img/flaky", bigPng, "image/png"); q.run("img/flaky", bigPng.length, "image/png", "2026-10-15T05:30:00Z");
  const realFetch500 = inst.containerFetch; inst.containerFetch = async () => new Response("container error", { status: 500 });
  await W.tick(env);
  check(row("img/flaky").state === "pending" && row("img/flaky").tries === 1, `a 500 from the container is tried again (${JSON.stringify(row("img/flaky"))})`);
  await W.tick(env); await W.tick(env); inst.containerFetch = realFetch500;
  check(row("img/flaky").state === "failed" && row("img/flaky").tries === 3, `after three tries it is marked failed (${JSON.stringify(row("img/flaky"))})`);
  const startsBefore = inst.starts; const after = await W.tick(env);
  check(after.idle === true && inst.starts === startsBefore, "with nothing left waiting, no container starts");
  q.run("img/big2", 600000, "image/png", "2026-10-15T06:00:00Z"); sq.prepare("UPDATE shrink_runs SET seconds = ?").run(W.SHRINK.monthCapS);
  const capped = await W.tick(env);
  check(capped.capped === true && inst.starts === startsBefore && W.SHRINK.monthCapS === 5 * 3600, `past the month's 5 hours nothing starts, whatever waits (${JSON.stringify(capped)})`);
  // a failed tick fails the scheduled event: Cloudflare records the first failed waitUntil as the cron's status
  const waits = []; const broken = { DB: { prepare() { throw new Error("D1 unavailable"); } } };
  await W.default.scheduled({ cron: "*/15 * * * *" }, broken, { waitUntil: (p) => waits.push(p) });
  const okWaits = []; await W.default.scheduled({ cron: "*/15 * * * *" }, env, { waitUntil: (p) => okWaits.push(p) });
  const [bad] = await Promise.allSettled(waits), [good] = await Promise.allSettled(okWaits);
  check(bad?.status === "rejected" && /D1 unavailable/.test(String(bad.reason?.message)) && good?.status === "fulfilled", `a failing run rejects the scheduled event's waitUntil and a working one fulfils it (${bad?.status}, ${good?.status})`);
  // a run starts only if a whole one fits: 5 minutes left is less than a batch plus one picture's deadline
  sq.prepare("UPDATE shrink_runs SET seconds = ?").run(W.SHRINK.monthCapS - 300);
  const tight = await W.tick(env);
  check(tight.capped === true && inst.starts === startsBefore, `with 5 minutes of the month left no run starts (${JSON.stringify(tight)})`);
  sq.prepare("UPDATE shrink_runs SET seconds = 0").run();
  // a picture past its deadline: the try is counted, the run ends and the container is stopped
  sq.prepare("UPDATE img_shrink SET state = 'done' WHERE state = 'pending'").run();
  await put("img/hang", bigPng, "image/png"); await put("img/after", bigPng, "image/png");
  q.run("img/hang", bigPng.length, "image/png", "2026-10-15T09:00:00Z"); q.run("img/after", bigPng.length, "image/png", "2026-10-15T08:00:00Z");
  const realFetchC = inst.containerFetch, itemMs = W.SHRINK.itemMs; W.SHRINK.itemMs = 300;
  inst.containerFetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  const stopsBefore = inst.stops, t0 = Date.now(); const hung = await W.tick(env); const took = Date.now() - t0;
  check(hung.timedOut === true && row("img/hang").state === "pending" && row("img/hang").tries === 1 && row("img/after").state === "pending" && row("img/after").tries === 0 && inst.stops === stopsBefore + 1 && took < 5000,
    `a picture past its deadline counts a try, ends the run before the next one, and the container is stopped (${took} ms, ${JSON.stringify(row("img/hang"))})`);
  // an answer that is not a WebP replaces nothing
  inst.containerFetch = async () => new Response("<html>not a picture</html>".repeat(10), { status: 200 });
  W.SHRINK.itemMs = itemMs; sq.prepare("UPDATE img_shrink SET state = 'done' WHERE key = 'img/after'").run();
  const beforeBytes = STORE._m.get("img/hang").buf.byteLength; await W.tick(env);
  check(row("img/hang").state === "pending" && /not a WebP/.test(row("img/hang").note || "") && STORE._m.get("img/hang").buf.byteLength === beforeBytes && STORE._m.get("img/hang").httpMetadata.contentType === "image/png",
    `an answer that is not a WebP leaves the stored picture as it was (${row("img/hang").note})`);
  inst.containerFetch = realFetchC;
  // One instance ran nine days because stop() is only SIGTERM, which node as PID 1 ignores. A container still running
  // after the stop wait is destroyed, and the run says so.
  const stopWait = W.SHRINK.stopWaitMs; W.SHRINK.stopWaitMs = 600;
  sq.prepare("UPDATE img_shrink SET state = 'done' WHERE state = 'pending'").run();
  await put("img/deaf", bigPng, "image/png"); q.run("img/deaf", bigPng.length, "image/png", "2026-10-15T10:00:00Z");
  inst.obeys = false; const killsBefore = inst.destroys, t1 = Date.now(); const deaf = await W.tick(env); const deafTook = Date.now() - t1;
  check(deaf.done === 1 && deaf.stop?.signalled === true && deaf.stop?.destroyed === true && !deaf.error && inst.destroys === killsBefore + 1 && !inst.container.running && deafTook >= 600 && deafTook < 4000,
    `a container that ignores SIGTERM is destroyed once the stop wait passes, and the run says so (${deafTook} ms, ${JSON.stringify(deaf.stop)})`);
  // an instance found running on an idle tick (a rollout started it, or no signal reached it) is ended and booked the whole time since
  // the object last saw its container down
  const seconds = () => sq.prepare("SELECT seconds, runs FROM shrink_runs").get();
  inst.container.running = true; inst.store.set("seenDown", Date.now() - 40 * 60_000);
  const booked = seconds(); const reaped = await W.tick(env), after2 = seconds();
  check(reaped.idle === true && reaped.reaped === true && reaped.why === "tick" && reaped.destroyed === true && !reaped.error && reaped.seconds >= 2399 && reaped.seconds <= 2402 && !inst.container.running
    && Math.round(after2.seconds - booked.seconds) >= 2399 && after2.runs === booked.runs,
    `an instance running on an idle tick is ended and booked the 40 minutes since the container was last seen down, not a run (${JSON.stringify(reaped)}, +${Math.round(after2.seconds - booked.seconds)} s)`);
  check(typeof inst.store.get("seenDown") === "number" && Date.now() - inst.store.get("seenDown") < 5000, "ending it records that the container is down now");
  inst.container.running = true; inst.store.set("seenDown", Date.now() - 120_000);
  const reaped2 = await W.tick(env);
  check(reaped2.reaped === true && reaped2.seconds >= 119 && reaped2.seconds <= 125 && !inst.container.running, `one seen running two minutes after it was last seen down is booked those two minutes (${JSON.stringify(reaped2)})`);
  const fresh = new W.Shrinker(env); fresh.container.running = true; fresh.obeys = false;
  const first = await fresh.reap();
  check(first.reaped === true && first.seconds === W.SHRINK.strayDefaultS && W.SHRINK.strayDefaultS === 900 && !fresh.container.running, `an object that has never seen its container down books one cron interval, 15 minutes (${JSON.stringify(first)})`);
  const quiet = await W.tick(env);
  check(quiet.idle === true && quiet.reaped === undefined && quiet.running === false && inst.destroys === killsBefore + 3, `with nothing running an idle tick ends nothing and notes the container is down (${JSON.stringify(quiet)})`);
  // the cap does not spare a stray instance
  inst.container.running = true; sq.prepare("UPDATE shrink_runs SET seconds = ?").run(W.SHRINK.monthCapS); q.run("img/capped", 600000, "image/png", "2026-10-15T11:00:00Z");
  const cappedReap = await W.tick(env);
  check(cappedReap.capped === true && cappedReap.reaped === true && !inst.container.running, `past the cap a stray instance is still ended (${JSON.stringify(cappedReap)})`);
  sq.prepare("UPDATE shrink_runs SET seconds = 0").run(); sq.prepare("UPDATE img_shrink SET state = 'done' WHERE key = 'img/capped'").run();
  // the idle timeout ends a stray the same way, never a batch in progress; an obedient container needs no kill
  inst.container.running = true; await inst.onActivityExpired();
  check(!inst.container.running && inst.destroys === killsBefore + 5, `the idle timeout ends a deaf container too (${inst.destroys - killsBefore} kills so far)`);
  inst.obeys = true; inst.container.running = true; const killsNow = inst.destroys; await inst.onActivityExpired();
  check(!inst.container.running && inst.destroys === killsNow, "an obedient container is stopped by the signal alone");
  inst.busy = true; inst.container.running = true; const stopsNow = inst.stops; await inst.onActivityExpired();
  check(inst.container.running === true && inst.stops === stopsNow && inst.destroys === killsNow, "the idle timeout leaves a container alone while a batch is in progress");
  // a tick must not end an instance mid-batch either
  const mid = await W.tick(env); inst.busy = false; inst.container.running = false;
  check(mid.idle === true && mid.reaped === undefined && mid.busy === true, `a tick leaves an instance alone while a batch is in progress (${JSON.stringify(mid)})`);
  // a start that fails after the process launched: the instance is still ended and booked, and the run carries the error
  await put("img/late", bigPng, "image/png"); q.run("img/late", bigPng.length, "image/png", "2026-10-15T12:00:00Z");
  inst.startFails = true; const runsBefore = seconds().runs; const late = await W.tick(env); inst.startFails = false;
  check(late.started === false && /never answered/.test(late.startError || "") && /start failed/.test(late.error || "") && !inst.container.running && seconds().runs === runsBefore + 1 && row("img/late").state === "pending",
    `a start that fails after the process launched still ends the instance, books the time and fails the run (${JSON.stringify({ startError: late.startError, error: late.error, stop: late.stop })})`);
  // a stop() that never returns does not stall the kill
  inst.stopHangs = true; inst.obeys = false; const t2 = Date.now(); const hung2 = await W.tick(env); const hungTook = Date.now() - t2; inst.stopHangs = false;
  check(hung2.done === 1 && hung2.stop?.stopTimeout === true && hung2.stop?.destroyed === true && !hung2.error && !inst.container.running && hungTook < 4000,
    `a stop() that never returns is given the stop wait and then the instance is destroyed (${hungTook} ms, ${JSON.stringify(hung2.stop)})`);
  // a kill that fails is an error on the run, and the scheduled event fails with it
  await put("img/stuck", bigPng, "image/png"); q.run("img/stuck", bigPng.length, "image/png", "2026-10-15T13:00:00Z");
  inst.destroyFails = true; const stuckWaits = []; await W.default.scheduled({ cron: "*/15 * * * *" }, env, { waitUntil: (p) => stuckWaits.push(p) });
  const [stuck] = await Promise.allSettled(stuckWaits); inst.destroyFails = false; inst.container.running = false; inst.obeys = true;
  check(stuck?.status === "rejected" && /still running/.test(String(stuck.reason?.message)), `an instance still running after stop and destroy fails the scheduled event (${stuck?.status}: ${String(stuck?.reason?.message).slice(0, 80)})`);
  // a booking that fails is an error on the run too: the cap reads the book
  await put("img/unbooked", bigPng, "image/png"); q.run("img/unbooked", bigPng.length, "image/png", "2026-10-15T14:00:00Z");
  const realPrepare = env.DB.prepare; env.DB.prepare = (sql) => { if (/INSERT INTO shrink_runs/.test(sql)) throw new Error("D1 write refused"); return realPrepare(sql); };
  const unbooked = await W.tick(env); env.DB.prepare = realPrepare;
  check(unbooked.done === 1 && /D1 write refused/.test(unbooked.bookError || "") && /not booked/.test(unbooked.error || "") && !inst.container.running, `a booking that fails is reported on the run (${unbooked.error})`);
  W.SHRINK.stopWaitMs = stopWait;
}
// the server ends itself on SIGTERM: as PID 1 in the container only a handler of its own can end it
const exitOf = (p, ms = 3000) => new Promise((res) => { const t = setTimeout(() => res(null), ms); p.once("exit", (code, signal) => { clearTimeout(t); res({ code, signal }); }); });
const srvExit = exitOf(srv); srv.kill("SIGTERM"); const ex = await srvExit;
check(ex && ex.code === 0, `the server exits with code 0 on SIGTERM, within 3 s (${JSON.stringify(ex)})`);
if (gitHas("92c22a4")) try {
  const oldFile = `${HUB}shrink/container/_old_server.mjs`; writeFileSync(oldFile, execSync("git show 92c22a4:hub/shrink/container/server.js", { cwd: HUB, encoding: "utf8" }));
  const oport = port + 1, osrv = spawn(process.execPath, [oldFile], { env: { ...process.env, PORT: String(oport) }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${oport}/`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const oexit = exitOf(osrv); osrv.kill("SIGTERM"); const oex = await oexit; unlinkSync(oldFile);
  check(oex && oex.code === null && oex.signal === "SIGTERM", `CONTROL: 92c22a4's server has no handler and ends only by the signal's default action, which PID 1 never gets (${JSON.stringify(oex)})`);
} catch (e) { check(false, "control server could not run: " + e.message); }

// ---------- 3. the hub queues big pictures and reports ----------
const stub = (src) => src
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
async function loadHub(tag, src) { const f = `${HUB}test/_shrink_hub_${tag}.mjs`; writeFileSync(f, stub(src)); try { return await import(f); } finally { unlinkSync(f); } }
const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))); };
const exp = Date.now() + 86400000, COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;
const BIG = await noise(900, 700).png().toBuffer(), SMALL = await noise(80, 60).png().toBuffer(), OPENED = await noise(1000, 800).png().toBuffer();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
  const b = { "/big.png": BIG, "/small.png": SMALL, "/opened.png": OPENED }[u.pathname]; if (!b) return new Response("nope", { status: 404 });
  return new Response(b, { headers: { "content-type": "image/png", "content-length": String(b.length) } });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
async function hubScenario(m) {
  const sq = buildDb(), sent = []; const env = { DB: d1(sq), STORE: r2(), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x", EMAIL: { send: async (x) => { sent.push(x); return { messageId: "<r@x>" }; } } };
  env.STORE.list = async () => ({ objects: [], truncated: false });
  await m.prefetchImages(env, '<img src="https://cdn.ex.com/big.png" width="600"><img src="https://cdn.ex.com/small.png" width="60">', "test", { left: { images: 99, bytes: 1e9 } });
  const call = (path, ctx = { waitUntil: () => {} }) => m.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE } }), env, ctx);
  const key = (await (await call("/api/me")).json()).img_key, waits = [];
  const res = await call("/api/img?u=" + encodeURIComponent("https://cdn.ex.com/opened.png") + "&k=" + key, { waitUntil: (p) => waits.push(p) }); await res.arrayBuffer(); await Promise.allSettled(waits);
  sq.prepare("UPDATE img_work SET state = 'done', out_bytes = 100000, done_at = ? WHERE bytes = ?").run(new Date().toISOString(), BIG.length);
  sq.prepare("INSERT INTO shrink_runs (month, seconds, runs) VALUES (?, 5400, 3)").run(new Date().toISOString().slice(0, 7));
  let report = ""; try { await m.dailyReport(env, []); report = (sent[0]?.text || "").split("\n").find((l) => l.startsWith("pictures shrunk")) || ""; } catch (e) { report = "CRASH " + e.message; }
  return { rows: sq.prepare("SELECT bytes, ct, state FROM img_work ORDER BY bytes").all(), seen: sq.prepare("SELECT COUNT(*) n FROM img_seen").get().n, report };
}
const hub = await hubScenario(await loadHub("fixed", readFileSync(HUB + "src/index.js", "utf8")));
check(BIG.length >= 500000 && OPENED.length >= 500000 && SMALL.length < 20000, `fixtures straddle 500 KB, the small one under a PNG's 20 KB (${BIG.length}, ${OPENED.length}, ${SMALL.length})`);
check(hub.seen === 3 && hub.rows.length === 2 && hub.rows.some((x) => x.bytes === BIG.length) && hub.rows.some((x) => x.bytes === OPENED.length && x.state === "pending"), `the hub queues (img_work) the 500 KB+ picture kept at arrival and the one kept at first open, not the small one, and notes all three as stored (${hub.seen}; ${JSON.stringify(hub.rows)})`);
check(/^pictures shrunk last 24h: 1 \([\d.]+ MB -> 0\.1 MB, both sizes\); left as sent 0; waiting 1; failed 0; pictures kept 3$/.test(hub.report), `the daily report carries the line (${hub.report})`);
let old = null;
if (gitHas("684a7e5")) try { old = await hubScenario(await loadHub("control", execSync("git show 684a7e5:hub/src/index.js", { cwd: HUB, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))); } catch (e) { check(false, "control could not run: " + e.message); }
if (old) check(old.rows.length === 0 && old.report === "", `CONTROL: HEAD 684a7e5's hub queues nothing and reports nothing (${old.rows.length} rows)`);
globalThis.fetch = realFetch;
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
