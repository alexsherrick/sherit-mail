// mailhub-shrink: shrinks the big pictures the mail hub keeps, with our own sharp code in a Cloudflare Container.
// Decided 2026-10-15: no Cloudflare Images service, our own code instead, and the account kept well under its free limits, with
// no paid service used unless it is needed.
//
// The hub queues every picture of 500 KB or more it keeps (img_shrink, index.js). Every 15 minutes this Worker looks for waiting rows:
// none, and it ends without starting anything. Otherwise the container starts, each original goes from R2 to sharp and back, and the
// container is stopped the moment the batch ends: Containers bill provisioned memory and disk for as long as an instance runs, so it
// runs only while there is work. A month cap on running time (shrink_runs, 5 h) keeps it far under the plan's included 25 GiB-hours.
// Stopping is made certain: the library's stop() only sends SIGTERM, which node as the container's PID 1 could not act
// on, and one instance ran from the 2026-10-16 rollout on (139.9 GiB-hours billed against the Worker's own book of 0.78 h). Now the
// image handles SIGTERM, stopHard() destroys an instance still running a few seconds after the signal, every tick with no batch to run
// ends and books an instance it finds running (one a rollout started, or one no signal reached), and a stop or booking that fails
// fails the scheduled event instead of reading as a success.
// A result replaces the stored copy under the same key only when it is under 80 % of the original; the original is not kept, and
// deleting a stored copy makes the hub fetch it from the sender again on the next open.
import { Container, getContainer } from "@cloudflare/containers";

// monthCapS: 5 hours a month, 5 GiB-hours of memory on `basic` against 25 included (20 %), lowered from 10 after a review.
// itemMs: the Worker's own deadline for one picture, past the container's 120 s sharp timeout.
// stopWaitMs: how long a stop waits for the signal to end the process before destroy() (SIGKILL); the handler in server.js exits at once.
// strayDefaultS: booked for an instance found running when this object has never yet seen its container down (the first tick of this
// code after a deploy): one cron interval, the longest a rollout-started instance runs before a tick finds it.
export const SHRINK = { width: 1600, quality: 82, keepUnder: 0.8, batch: 40, batchMs: 8 * 60_000, itemMs: 150_000, monthCapS: 5 * 3600, maxTries: 3, stopWaitMs: 5_000, strayDefaultS: 15 * 60 };
const now = () => new Date().toISOString();
const month = () => now().slice(0, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String(e?.message || e).slice(0, 120);
const bookSeconds = (db, s, runs) => db.prepare("INSERT INTO shrink_runs (month, seconds, runs) VALUES (?, ?, ?) ON CONFLICT (month) DO UPDATE SET seconds = seconds + excluded.seconds, runs = runs + excluded.runs").bind(month(), s, runs).run();

export class Shrinker extends Container {
  defaultPort = 8080;
  sleepAfter = "1m";       // a backstop: a batch stops the container itself when it ends; past this idle time onActivityExpired does
  enableInternet = false;  // it is handed bytes and hands bytes back; nothing else
  chain = Promise.resolve();   // a batch, a reap and the idle timeout's stop run one after another, never interleaved across their awaits

  serial(fn) { const run = this.chain.then(fn, fn); this.chain = run.then(() => {}, () => {}); return run; }
  // When this object last saw its container not running: the floor for how long a stray instance can have run unseen.
  async seenDown() { try { await this.ctx.storage.put("seenDown", Date.now()); } catch (_) {} }
  async lastSeenDown() { try { return await this.ctx.storage.get("seenDown"); } catch (_) { return undefined; } }

  // Ends the instance for certain. The library's stop() sends SIGTERM and returns; "The only signals that can be sent to process ID 1
  // .. are those for which init has explicitly installed signal handlers" (kill(2)), and node's built-in handler resets itself and
  // re-raises, so without the listener in server.js the signal did nothing. destroy() is the platform's SIGKILL. Each step is bounded
  // and caught, and the answer says which one ended it (or that none did), so the logs show whether SIGTERM works in production.
  async stopHard() {
    const out = { signalled: false, destroyed: false };
    if (!this.container.running) return out;
    const until = Date.now() + SHRINK.stopWaitMs;
    try {
      const won = await Promise.race([this.stop().then(() => "stopped"), sleep(SHRINK.stopWaitMs).then(() => "timeout")]);
      if (won === "stopped") out.signalled = true; else out.stopTimeout = true;
    } catch (e) { out.stopError = errText(e); }
    while (this.container.running && Date.now() < until) await sleep(250);
    if (this.container.running) { try { await this.destroy(); out.destroyed = true; } catch (e) { out.destroyError = errText(e); } }
    if (this.container.running) out.stillRunning = true; else await this.seenDown();
    return out;
  }

  // An instance running with no batch in progress (one a rollout started, or one no signal ended) is ended, and the whole time since
  // this object last saw its container down is booked to the month (the most it can have run; no run is counted). A failure here is an
  // error on the result, so the scheduled event that called it fails.
  async endStray(why) {
    if (!this.container.running) { await this.seenDown(); return { running: false }; }
    const down = await this.lastSeenDown();
    const since = typeof down === "number" ? Math.max(0, (Date.now() - down) / 1000) : SHRINK.strayDefaultS;
    const r = await this.stopHard(), out = { reaped: true, why, seconds: Math.round(since), ...r };
    try { await bookSeconds(this.env.DB, since, 0); } catch (e) { out.bookError = errText(e); }
    const bad = [];
    if (r.stillRunning) bad.push("stray instance still running after stop and destroy");
    if (out.bookError) bad.push("stray time not booked: " + out.bookError);
    if (bad.length) out.error = bad.join("; ");
    return out;
  }
  async reap() { if (this.busy) return { running: !!this.container.running, busy: true }; return this.serial(() => this.endStray("tick")); }
  // The library calls this when sleepAfter passes with no request in flight; never while a batch is running.
  async onActivityExpired() { if (this.busy) return; console.log("shrink idle", JSON.stringify(await this.serial(() => this.endStray("idle")))); }
  // The library fires this after the process has exited (monitor() settled, or the state sync found it not running), not on the signal.
  onStop(p) { console.log("shrink container exited", JSON.stringify(p)); }

  // One batch: the newest waiting pictures first (the ones about to be opened), until the batch or its time runs out.
  async runBatch() {
    if (this.busy) return { busy: true };
    return this.serial(() => this.batch());
  }
  async batch() {
    this.busy = true;
    const db = this.env.DB, t0 = Date.now(), r = { done: 0, skipped: 0, failed: 0, before: 0, after: 0, started: false };
    try {
      const rows = (await db.prepare("SELECT key, bytes, tries FROM img_shrink WHERE state = 'pending' ORDER BY at DESC LIMIT ?").bind(SHRINK.batch).all()).results || [];
      if (!rows.length) return r;
      try { await this.startAndWaitForPorts(); r.started = true; } catch (e) { r.startError = errText(e); return r; }
      for (const row of rows) {
        if (Date.now() - t0 > SHRINK.batchMs) break;
        await shrinkOne(this.env, row, (body) => this.containerFetch(`http://shrinker/shrink?w=${SHRINK.width}&q=${SHRINK.quality}`, { method: "POST", body, signal: AbortSignal.timeout(SHRINK.itemMs) }), r);
        if (r.timedOut) break;   // a picture past its deadline may still be holding the container: stop it (finally) and end the run
      }
      return r;
    } finally {
      // Whatever happened above (a start that failed after the process launched included) an instance still running is ended, and
      // the time is booked. A stop, kill or booking that fails is an error on the result; the caller fails the scheduled event with it.
      const ran = r.started || !!this.container.running;
      if (this.container.running) { try { r.stop = await this.stopHard(); } catch (e) { r.stopError = errText(e); } }
      else if (r.started) await this.seenDown();
      if (ran) { try { await bookSeconds(db, (Date.now() - t0) / 1000, 1); } catch (e) { r.bookError = errText(e); } }
      const bad = [];
      if (r.startError) bad.push("container start failed: " + r.startError);
      if (r.stopError) bad.push("stop threw: " + r.stopError);
      if (r.stop?.stillRunning) bad.push("instance still running after stop and destroy");
      if (r.bookError) bad.push("running time not booked: " + r.bookError);
      if (bad.length) r.error = bad.join("; ");
      this.busy = false;
    }
  }
}

// One picture: its stored copy through the shrinker, kept only if it came out under 80 % of the original.
export async function shrinkOne(env, row, shrink, r) {
  const db = env.DB, mark = (state, extra = {}) => db.prepare("UPDATE img_shrink SET state = ?, out_bytes = ?, tries = ?, note = ?, done_at = ? WHERE key = ?")
    .bind(state, extra.out ?? null, extra.tries ?? row.tries, extra.note ?? null, state === "pending" ? null : now(), row.key).run();
  try {
    const obj = await env.STORE.get(row.key);
    if (!obj) { await mark("skipped", { note: "no stored copy" }); r.skipped++; return; }
    if (obj.customMetadata?.shrunk) { await mark("skipped", { note: "already shrunk" }); r.skipped++; return; }
    const buf = await obj.arrayBuffer();
    const res = await shrink(buf);
    if (!res.ok) {
      const tries = (row.tries || 0) + 1, note = `${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`;
      // 413 and 422 are the container's answer about this picture: over 20 MiB, past the pixel or frame ceiling, or bytes sharp cannot read
      // or finish. A second try gets the same answer, so the picture is left as sent now (four GIFs over the pixel ceiling
      // went back to the queue twice each, and a refusal waiting alone starts the container just to be refused again).
      if (res.status === 413 || res.status === 422) { await mark("skipped", { tries, note }); r.skipped++; return; }
      await mark(tries >= SHRINK.maxTries ? "failed" : "pending", { tries, note }); if (tries >= SHRINK.maxTries) r.failed++; return;
    }
    const out = await res.arrayBuffer(), h = new Uint8Array(out, 0, Math.min(12, out.byteLength));
    // Only a WebP replaces a stored picture (RIFF....WEBP), whatever the container answered.
    if (!(h.length === 12 && String.fromCharCode(...h.subarray(0, 4)) === "RIFF" && String.fromCharCode(...h.subarray(8, 12)) === "WEBP")) {
      const tries = (row.tries || 0) + 1; await mark(tries >= SHRINK.maxTries ? "failed" : "pending", { tries, note: "the shrinker's answer is not a WebP" }); if (tries >= SHRINK.maxTries) r.failed++; return;
    }
    if (out.byteLength >= buf.byteLength * SHRINK.keepUnder) { await mark("skipped", { out: out.byteLength, note: "not smaller enough" }); r.skipped++; return; }
    await env.STORE.put(row.key, out, { httpMetadata: { contentType: "image/webp" }, customMetadata: { ...(obj.customMetadata || {}), shrunk: now(), from: String(buf.byteLength), was: obj.httpMetadata?.contentType || "" } });
    await mark("done", { out: out.byteLength }); r.done++; r.before += buf.byteLength; r.after += out.byteLength;
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") r.timedOut = true;
    const tries = (row.tries || 0) + 1;
    try { await mark(tries >= SHRINK.maxTries ? "failed" : "pending", { tries, note: String(e?.message || e).slice(0, 160) }); } catch (_) {}
    if (tries >= SHRINK.maxTries) r.failed++;
  }
}

// The cron: nothing waiting, or the month's running time used up, and no container starts, and one found running anyway is ended.
export async function tick(env) {
  const used = (await env.DB.prepare("SELECT seconds FROM shrink_runs WHERE month = ?").bind(month()).first())?.seconds || 0;
  // A run starts only if a whole one fits in what is left of the month: its batch time, one picture's deadline and the stop wait.
  if (used + (SHRINK.batchMs + SHRINK.itemMs + SHRINK.stopWaitMs) / 1000 > SHRINK.monthCapS) return { capped: true, used, ...(await reap(env)) };
  if (!(await env.DB.prepare("SELECT 1 x FROM img_shrink WHERE state = 'pending' LIMIT 1").first())) return { idle: true, ...(await reap(env)) };
  return getContainer(env.SHRINKER, "shrinker").runBatch();
}
const reap = (env) => getContainer(env.SHRINKER, "shrinker").reap();

export default {
  fetch() { return new Response("not found", { status: 404 }); },
  // A failed tick fails the scheduled event: Cloudflare records "the first ctx.waitUntil to fail... as the status in the Cron Trigger
  // Past Events table. Otherwise, it will be reported as a success" (scheduled-handler docs). Catching the error here had made every
  // failure read as a success. A result carrying `error` (an instance not ended, time not booked, a start
  // that failed) fails it too.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env).then((r) => { console.log("shrink", JSON.stringify(r)); if (r.error) throw new Error(r.error); }, (e) => { console.log("shrink error", String(e?.message || e)); throw e; }));
  },
};
