// mailhub-img: shrinks the pictures the mail hub keeps, with our own streaming WebAssembly shrinker (../wasm/shrink.c:
// libjpeg-turbo, libspng, giflib and libwebp under a resizer that works a strip of rows at a time, so memory follows the output size).
// A Worker of its own, so a heavy picture never shares an isolate's 128 MB with the hub's mail. It replaces the container shrinker
// (mailhub-shrink) for every picture queued from now on: that one reads img_shrink, this one img_work.
//
// Every minute it claims the newest waiting pictures one at a time and writes a desktop (1600 px) and a phone (1080 px) WebP under
// keys of their own, imgv/<sha>-1600 and imgv/<sha>-1080, each kept only when it is under 80 % of the original. Once the desktop size is
// written the original is deleted (the phone falls back to the desktop size); a picture neither size helps keeps its original.
import SHRINK_WASM from "../wasm/shrink.wasm";
import { logoMark } from "./logomark.js";

export const IMG = { widths: [1600, 1080], quality: 82, methodStill: 4, methodAnim: 2, methodLean: 2, keepUnder: 0.8, batch: 12, batchMs: 25_000, staleMs: 10 * 60_000,
  maxTries: 3, maxPx: 20_000_000, maxFrames: 2000, reuse: 25, maxBytes: 16 * 1024 * 1024 };
const RC = ["ok", "keep", "unsupported", "too big", "bad", "no memory"];
const now = () => new Date().toISOString();

// One instance is reused for up to IMG.reuse pictures, so a run never holds two instances' memory while the collector catches up;
// any throw out of it (libjpeg's error exit, an allocation that failed) drops it, since its stack and heap may be left mid-call.
let inst = null, uses = 0, bigDrops = 0;
// A dropped instance's memory is freed only when V8 collects it: one that had grown past 32 MiB and the next picture's could together pass
// the isolate's 128 MB, so a run that sees a big drop takes no further width or picture. Every drop goes
// through here, retirement after IMG.reuse pictures included, and that retirement happens when a picture is done, never just before the
// next one is made; the count is compared per run, so an overlapping tick cannot clear another's.
const drop = () => { if (inst && inst.exports.memory.buffer.byteLength > 32 * 1048576) bigDrops++; inst = null; };
export const bigDropCount = () => bigDrops;
function instance() {
  if (inst) return inst;
  let mem; const badf = () => 8;   // the module touches no files
  inst = new WebAssembly.Instance(SHRINK_WASM, {
    wasi_snapshot_preview1: {
      environ_get: () => 0, environ_sizes_get: (a, b) => { const v = new DataView(mem.buffer); v.setUint32(a, 0, true); v.setUint32(b, 0, true); return 0; },
      clock_time_get: (id, prec, out) => { new DataView(mem.buffer).setBigUint64(out, 0n, true); return 0; },
      fd_close: badf, fd_prestat_get: badf, fd_prestat_dir_name: badf, fd_seek: badf, fd_write: badf,
      proc_exit: (c) => { throw new Error("proc_exit " + c); },
    },
    env: { sk_throw: (c) => { throw new Error("shrink: " + (RC[c] || c)); } },
  });
  mem = inst.exports.memory; inst.exports._initialize(); uses = 0;
  return inst;
}

// A picture's bytes to a WebP no wider than maxW. { rc: "ok", out, w, h, frames } or { rc, note }.
export function shrinkBytes(buf, maxW, method) {
  const e = instance().exports, bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf); uses++;
  const p = e.sk_alloc(bytes.length); if (!p) { drop(); return { rc: "no memory", note: "input" }; }
  new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
  let rc;
  try { rc = e.sk_shrink(p, bytes.length, maxW, IMG.maxPx, IMG.quality, method, IMG.maxFrames); }
  catch (err) { drop(); return { rc: "threw", note: String(err?.message || err).slice(0, 120) }; }
  e.sk_free(p);
  const note = new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.sk_err(), 160)).split("\0")[0];
  const base = { inW: e.sk_in_w(), inH: e.sk_in_h() };
  // A refusal may leave the module's heap fragmented or, on a path that returned early, holding what it allocated: the next picture
  // gets a fresh instance.
  if (rc !== 0) { drop(); return { rc: RC[rc] || String(rc), note, ...base }; }
  const out = new Uint8Array(e.memory.buffer, e.sk_out_ptr(), e.sk_out_len()).slice();
  const res = { rc: "ok", out, w: e.sk_out_w(), h: e.sk_out_h(), frames: e.sk_frames(), ...base };
  e.sk_release();
  if (uses >= IMG.reuse) drop();   // retired now, while nothing else is alive
  return res;
}

const isGif = (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
const isWebp = (b) => b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP";

// One claimed picture through both sizes. A refusal from the shrinker is about the picture (too big, not a picture it reads, a corrupt
// file): the picture keeps its original and is not tried again. Only a failure around it (R2, D1) is retried, three times.
export async function shrinkOne(env, row, r) {
  const db = env.DB, sha = row.key.slice(4);
  // Fenced by the claim: a run whose claim was taken back (it ran past ten minutes, or was killed) writes nothing over the next one's.
  // `kept`: what the hub keeps of the picture now, both sizes and the original when it stays; its sender's share of the
  // day counts the picture at this size, not at the size it was fetched.
  const mark = (state, x = {}) => db.prepare("UPDATE img_work SET state = ?, out_bytes = ?, kept = ?, tries = ?, note = ?, done_at = ?, claimed_at = NULL WHERE key = ? AND state = 'working' AND claimed_at = ?")
    .bind(state, x.out ?? null, x.kept ?? null, x.tries ?? row.tries, x.note ?? null, state === "pending" ? null : now(), row.key, row.claim).run();
  try {
    if (row.bytes > IMG.maxBytes) { await mark("skipped", { note: `over ${IMG.maxBytes} bytes` }); r.skipped++; return; }
    const obj = await env.STORE.get(row.key);
    if (!obj) {   // gone already: its desktop size replaced it (a run before this one finished), or the sweep took it
      const sized = await env.STORE.head(`imgv/${sha}-1600`);
      await mark(sized ? "done" : "skipped", { note: sized ? "already sized" : "no stored copy" }); if (sized) r.done++; else r.skipped++; return;
    }
    if ((obj.size || 0) > IMG.maxBytes) { await mark("skipped", { note: `over ${IMG.maxBytes} bytes` }); r.skipped++; return; }
    const buf = new Uint8Array(await obj.arrayBuffer()), was = obj.httpMetadata?.contentType || "";
    // Out of memory: a picture with transparency can need more than the module's 88 MiB at the desktop size, since
    // libwebp packs the alpha plane with its lossless coder at the picture's effort (2 of 1,220 pictures by 2026-11-26, both PNGs: a
    // 2,000 x 2,000 fits at effort 3 in 55 MiB, a 1,766 x 4,096 at 1,600 px fits at none, though its 1,080 px size does). Such a picture
    // is not given up: the next minute tries it at effort 2 ("lean:"), then, if the desktop size still does not fit, makes the phone size
    // alone ("lean: phone"), the original staying for the desktop. This run, having dropped a grown instance, takes nothing more.
    const lean = /^lean/.test(row.note || ""), phoneOnly = /^lean: phone/.test(row.note || "");
    const method = isGif(buf) ? IMG.methodAnim : lean ? IMG.methodLean : IMG.methodStill, notes = [], kept = {};
    let inW = 0;
    for (const W of IMG.widths) {
      if (W === 1600 && phoneOnly) { notes.push(`1600: no memory at effort ${IMG.methodLean} (the original stays for the desktop)`); continue; }
      if (W === 1080 && inW && inW <= 1080) break;   // no wider than the phone: the desktop size serves both
      if (bigDrops !== r.drops0) { notes.push(`${W}: skipped (a big instance was dropped in this run; the phone takes the desktop size)`); break; }
      const res = shrinkBytes(buf, W, method); inW = res.inW || inW;
      if (res.rc === "no memory" && !isGif(buf) && !(lean && (W === 1080 || phoneOnly))) {
        await mark("pending", { note: lean ? `lean: phone size only (${W}: no memory at effort ${method})` : `lean: ${W}: no memory at effort ${method}; again at effort ${IMG.methodLean}` });
        r.retried++; return;
      }
      if (res.rc !== "ok") { notes.push(`${W}: ${res.rc}${res.note ? " (" + res.note + ")" : ""}`); if (W === 1600 && res.rc !== "keep") break; continue; }
      if (!isWebp(res.out)) { notes.push(`${W}: not a WebP`); continue; }
      if (res.out.byteLength >= buf.byteLength * IMG.keepUnder) { notes.push(`${W}: ${res.out.byteLength} not under 80 % of ${buf.byteLength}`); continue; }
      await env.STORE.put(`imgv/${sha}-${W}`, res.out, { httpMetadata: { contentType: "image/webp" }, customMetadata: { at: now(), from: String(buf.byteLength), was, w: String(res.w), h: String(res.h) } });
      kept[W] = res.out.byteLength;
    }
    const out = Object.values(kept).reduce((a, b) => a + b, 0);
    if (kept[1600]) await env.STORE.delete(row.key);   // the desktop size covers the original; the phone falls back to it
    await db.prepare("INSERT INTO img_seen (sha, stored_at) VALUES (?, ?) ON CONFLICT(sha) DO NOTHING").bind(sha, now()).run();
    if (out) {
      const keptBytes = kept[1600] ? out : buf.byteLength + out;
      await mark("done", { out, kept: keptBytes, note: notes.join("; ") || null }); r.done++; r.before += buf.byteLength; r.after += keptBytes;
      // The sender's share has room again: its pictures waiting for room are due now, and the hub's next minute fetches what fits.
      if (row.dom && keptBytes < buf.byteLength) await db.prepare("UPDATE img_queue SET next_at = ? WHERE state = 'pending' AND kind = 'over' AND dom = ? AND next_at > ?").bind(now(), row.dom, now()).run().catch(() => {});
    }
    else { await mark("skipped", { note: notes.join("; ").slice(0, 200) || "nothing smaller" }); r.skipped++; }
  } catch (e) {
    const tries = (row.tries || 0) + 1;
    try { await mark(tries >= IMG.maxTries ? "failed" : "pending", { tries, note: String(e?.message || e).slice(0, 160) }); } catch (_) {}
    if (tries >= IMG.maxTries) r.failed++;
  }
}

// The cron: claims of crashed runs taken back, then the newest waiting pictures, each claimed before it is shrunk.
export async function tick(env) {
  const db = env.DB, t0 = Date.now(), r = { n: 0, done: 0, skipped: 0, failed: 0, retried: 0, before: 0, after: 0, drops0: bigDrops };
  // A claim older than ten minutes was a run killed past its CPU or memory limit (or one still running past any sane time): it counts as
  // a try, so a picture that kills every run gives up after three instead of being taken back for ever.
  await db.prepare("UPDATE img_work SET tries = tries + 1, state = CASE WHEN tries + 1 >= ? THEN 'failed' ELSE 'pending' END, note = 'claim taken back: the run that had it ended without a word', done_at = CASE WHEN tries + 1 >= ? THEN ? ELSE NULL END, claimed_at = NULL WHERE state = 'working' AND claimed_at < ?")
    .bind(IMG.maxTries, IMG.maxTries, now(), new Date(Date.now() - IMG.staleMs).toISOString()).run();
  // Fewest tries first: a picture whose run was killed waits behind the ones never tried, so it cannot be claimed first by every tick.
  const rows = (await db.prepare("SELECT key, bytes, tries, dom, note FROM img_work WHERE state = 'pending' ORDER BY tries, at DESC LIMIT ?").bind(IMG.batch).all()).results || [];
  for (const row of rows) {
    if (Date.now() - t0 > IMG.batchMs || bigDrops !== r.drops0) break;
    const token = now() + "#" + crypto.randomUUID().slice(0, 8);   // sorts by time; unique per claim
    const claim = await db.prepare("UPDATE img_work SET state = 'working', claimed_at = ? WHERE key = ? AND state = 'pending'").bind(token, row.key).run();
    if (!claim.meta?.changes) continue;   // another tick took it
    r.n++; await shrinkOne(env, { ...row, claim: token }, r);
  }
  if (r.n) await db.prepare("INSERT INTO events (kind, detail) VALUES ('img_shrink', ?)").bind(`n=${r.n} done=${r.done} skipped=${r.skipped} failed=${r.failed}${r.retried ? ` lean=${r.retried}` : ""} before=${r.before} after=${r.after} ms=${Date.now() - t0}`).run();
  return r;
}

export default {
  // The hub's only way in (a service binding; this Worker has no public URL): a logo's fingerprint (logomark.js).
  async fetch(request) {
    const u = new URL(request.url);
    if (request.method !== "POST" || u.pathname !== "/logo-mark") return new Response("not found", { status: 404 });
    const b = new Uint8Array(await request.arrayBuffer());
    if (b.length > 512 * 1024) return Response.json({ error: "too big" }, { status: 413 });
    try { const m = await logoMark(b); return Response.json(m || { error: "not a picture this reads" }, { status: m ? 200 : 422 }); }
    catch (e) { return Response.json({ error: String(e?.message || e).slice(0, 160) }, { status: 500 }); }
  },
  // A failed tick fails the scheduled event, so the Cron Trigger's past events show it (as mailhub-shrink does).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env).then((r) => { if (r.n) console.log("img", JSON.stringify(r)); }, (e) => { console.log("img error", String(e?.message || e)); throw e; }));
  },
};
