/* queue.js: the modifier queue. Every user action is a modifier: the local change is applied
   synchronously (the UI never waits), the modifier is persisted to IndexedDB, and a drainer replays it against the backend
   in per-thread order with retries; on permanent failure the inverse is applied locally and the user is told. Sends live in
   the same queue with a not-before time (the undo window) and an idempotency key so a retry never double-sends. */
const Q = { maxAttempts: 6, undoMs: 5000, parallel: 4, recentMs: 120000, undoMaxAgeMs: 15 * 60_000 };
const queue = {
  mem: new Map(), draining: false, timer: null,
  gone: new Map(), // key -> removed-at: a row this window just completed must not come back from a concurrent IndexedDB read
  // Merge with IndexedDB: rows other windows added appear here, rows other windows completed leave (volatile rows are memory-only).
  async load() { try { const rec = (await idb.meta("recentKeys")) || {}; const cut = Date.now() - Q.recentMs; for (const [k, at] of Object.entries(rec)) if (at >= cut && !(this.recent.get(k) >= at)) this.recent.set(k, at); } catch (_) {} // keys other windows persisted lately stay protected here too
    const tomb = (() => { try { return new Set(JSON.parse(localStorage.getItem("mh:qgone") || "[]")); } catch (_) { return new Set(); } })();   // see remove()
    const rows = await idb.getAll("queue"); const keys = new Set(); const cut = Date.now() - 60_000; for (const [k, at] of this.gone) if (at < cut) this.gone.delete(k);
    if (tomb.size && idb.db) { await Promise.all(rows.filter((r) => tomb.has(r.key)).map((r) => idb.del("queue", r.key))); if (idb.db) { try { localStorage.removeItem("mh:qgone"); } catch (_) {} } }
    for (const r of rows) { keys.add(r.key); if (this.gone.has(r.key) || tomb.has(r.key)) continue; if (r.status === "done") { idb.del("queue", r.key); continue; } this.mem.set(r.key, r); } /* the durable row always wins: a persist in flight keeps its own object and removes or updates it by key */ for (const [k, r] of this.mem) if (!keys.has(k) && !r.volatile) this.mem.delete(k); },
  async add(mod) {
    const row = { key: uuid4(), createdAt: Date.now(), attempts: 0, status: "pending", notBefore: 0, ...mod };
    this.mem.set(row.key, row);
    try { await idb.putAllStrict("queue", [row]); } catch (e) { row.volatile = true; if (!queue.warnedVolatile) { queue.warnedVolatile = true; toast("This device could not save the action to disk - it applies only while this tab stays open", 8000); } }
    // serviceWorker.ready never settles where no worker activates, and callers (queueSend) await add() before showing the undo bar
    this.kick(); try { (await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(r, 3000))]))?.sync?.register("mh-drain").catch(() => {}); } catch (_) {}
    if (typeof broadcast === "function") broadcast({ type: "queue" }); // other windows pick the row up (and protect its thread) at once
    return row;
  },
  // With the store stalled (store.js) idb.del() cannot delete, and the row: a send already reported "not confirmed", or one already
  // sent: would come back from IndexedDB after the restart that follows and go out again. Its key is
  // kept in localStorage until load() can delete the row for real.
  async remove(key) { this.mem.delete(key); this.gone.set(key, Date.now()); if (!idb.db) { try { const g = JSON.parse(localStorage.getItem("mh:qgone") || "[]"); if (!g.includes(key)) g.push(key); localStorage.setItem("mh:qgone", JSON.stringify(g.slice(-500))); } catch (_) {} } await idb.del("queue", key); },
  async update(row) { this.mem.set(row.key, row); if (!row.volatile) await idb.putAll("queue", [row]); },
  pending() { return [...this.mem.values()].filter((r) => r.status === "pending"); },
  recent: new Map(), // key -> persisted-at; protects local state from a stale sync for RECENT_MS after the server accepted the change
  pendingKeys() { const s = new Set(); const cut = Date.now() - Q.recentMs; for (const [k, at] of this.recent) { if (at < cut) this.recent.delete(k); else s.add(k); } for (const r of this.mem.values()) { if (r.status !== "pending") continue; if (r.op === "bulk") (r.args.keys || []).forEach((k) => s.add(k)); else if (r.threadKey && !String(r.threadKey).startsWith("send:")) s.add(r.threadKey); } return s; },
  kick(delay = 0) { clearTimeout(this.timer); this.timer = setTimeout(() => this.drain().catch(() => {}), delay); },
  async drain() { // a caller that awaits drain() gets the drain that is actually running, not an early return
    if (this.inflight) return this.inflight;
    this.inflight = this.drainNow().finally(() => { this.inflight = null; }); return this.inflight;
  },
  async drainNow() {
    if (this.draining) return; this.draining = true;
    try {
      const run = async () => {
        await this.load(); // the union of every window's rows: whichever window holds the lock drains them all
        const now = Date.now(); const byThread = new Map();
        for (const r of this.pending().sort((a, b) => a.createdAt - b.createdAt)) { if (r.notBefore > now) continue; const g = byThread.get(r.threadKey || r.key) || []; g.push(r); byThread.set(r.threadKey || r.key, g); }
        // Bulk rows run first and one at a time; per-thread rows whose key is inside a
        // pending bulk job wait, so an action, its undo and any newer single action reach the server in order.
        const bulkLanes = [...byThread.entries()].filter(([k]) => String(k).startsWith("bulk:")).map(([, v]) => v);
        for (const lane of bulkLanes) for (const r of lane) { const ok = await this.persist(r); if (!ok) break; }
        const held = new Set(); for (const r of this.pending()) if (r.op === "bulk") (r.args.keys || []).forEach((k) => held.add(k));
        const lanes = [...byThread.entries()].filter(([k, v]) => !String(k).startsWith("bulk:") && !held.has(k) && !v.some((r) => r.op === "bulk")).map(([, v]) => v); let next = 0;
        const worker = async () => { while (next < lanes.length) { const lane = lanes[next++]; for (const r of lane) { const ok = await this.persist(r); if (!ok) break; } } };
        await Promise.all(Array.from({ length: Math.min(Q.parallel, lanes.length) }, worker));
        if (held.size) this.kick(2000);
        const soon = this.pending().map((r) => r.notBefore).filter((t) => t > Date.now()); if (soon.length) this.kick(Math.min(...soon) - Date.now() + 50);
        const retry = this.pending().some((r) => r.attempts > 0 && r.notBefore <= Date.now()); if (retry) this.kick(3000);
        // A row skipped because the device said it was offline keeps attempts 0, and nothing above looks at it again: it waited for an
        // "online" event, which a phone waking from sleep does not always deliver. My phone: a read sat at
        // "attempts 0 · due now" while Gmail still had the mail unread. Now it is looked at again in ten seconds.
        if (this.skippedOffline) { this.skippedOffline = false; this.kick(10_000); }
      };
      if (navigator.locks?.request) await navigator.locks.request("mh-drain", { ifAvailable: true }, async (lock) => { if (lock) await run(); else this.kick(3000); }); // another window is draining: look again soon
      else await run();
    } finally { this.draining = false; try { if (!this.pending().length && typeof flushDeferredDeletes === "function") await flushDeferredDeletes(); } catch (_) {} // a hub deletion held back by one of these rows is applied now
      try { if (document.hidden && typeof recoverStore === "function") recoverStore(); } catch (_) {} } // a store recovery that waited on this queue while the app was out of sight
  },
  // An undo only makes sense right after the action it reverses. One that surfaces much later (a row stranded in another window, a
  // retry after a long quota pause) puts mail back in the inbox as unread and reverses whatever was done since (Five
  // threads kept returning to Gmail's inbox). Such rows are dropped, not sent.
  staleUndo(r) { const undo = (r.op === "bulk" && r.args?.action === "undo") || (r.op === "thread" && r.args?.undo); return undo && Date.now() - (r.createdAt || 0) > Q.undoMaxAgeMs; },
  async discard(key) { const r = this.mem.get(key); if (!r) return; const h = modifierHandlers[r.op]; try { if (h?.rollback) await h.rollback(r); } catch (_) {} await this.remove(key); if (typeof broadcast === "function") broadcast({ type: "queue" }); },
  async persist(r) {
    if (!navigator.onLine) { this.skippedOffline = true; return false; }
    if (this.staleUndo(r)) { await this.discard(r.key); toast(`An old undo (${Math.round((Date.now() - r.createdAt) / 60000)} min) was discarded instead of putting mail back in the inbox`, 8000); return true; } // rolled back locally (durably), lane continues
    try {
      const h = modifierHandlers[r.op]; if (!h) throw Object.assign(new Error("unknown modifier " + r.op), { permanent: true });
      r.sending = true;   // Undo checks this: once a send has started, "Send cancelled" would be a lie
      const res = await h.persist(r);
      const doneKeys = (r.op === "bulk" ? (r.args.keys || []) : [r.threadKey]).filter((k) => k && !String(k).startsWith("send:")); for (const k of doneKeys) this.recent.set(k, Date.now()); // a sync that was already in flight must not undo this
      if (typeof broadcast === "function") broadcast({ type: "recent", keys: doneKeys });
      if (doneKeys.length) { try { const rec = (await idb.meta("recentKeys")) || {}; const cut = Date.now() - Q.recentMs; for (const k of Object.keys(rec)) if (rec[k] < cut) delete rec[k]; for (const k of doneKeys) rec[k] = Date.now(); await idb.meta("recentKeys", rec); } catch (_) {} } // durable: a window that missed the broadcast reads it at its next load
      r.status = "done"; await this.update(r); // durable first: if the delete below fails, no window ever sends this row again
      await this.remove(r.key); if (h.after) await h.after(r, res); return true;
    } catch (e) {
      r.sending = false;
      if (e?.status === 429) { r.error = String(e?.message || e).slice(0, 200); r.rateLimited = (r.rateLimited || 0) + 1; if (r.rateLimited <= 10) { r.notBefore = Date.now() + 62_000; r.status = "pending"; await this.update(r); if (!queue.warned429 || Date.now() - queue.warned429 > 120_000) { queue.warned429 = Date.now(); toast("Gmail is rate-limiting; your action is queued and retries in a minute", 6000); } return false; } }
      r.attempts++; r.error = String(e?.message || e).slice(0, 200); r.code = e?.code || null; r.messageId = e?.message_id || null; // handlers' rollback() can see why
      const permanent = e?.permanent || [400, 403, 404, 405, 409, 422].includes(e?.status) || (!e?.status && /\b(400|403|404)\b|not found|invalid|permission/i.test(r.error) && !/429|5\d\d|network|fetch|timeout/i.test(r.error)); // 401 (signed out) and 429/5xx retry
      if (permanent || r.attempts >= Q.maxAttempts) { await this.remove(r.key); const h = modifierHandlers[r.op]; let told = false; if (h?.rollback) { try { told = (await h.rollback(r)) === true; } catch (_) {} } if (!told) toast(`${(h?.label || r.op)} failed: ${r.error}`, 6000); return false; } // a rollback that returns true has already told the user
      r.notBefore = Date.now() + Math.min(60_000, 1000 * 2 ** r.attempts); r.status = "pending"; await this.update(r); return false;
    }
  },
};
const uuid4 = () => (crypto.randomUUID ? crypto.randomUUID() : "x" + Math.random().toString(36).slice(2) + Date.now());
// Handlers are registered by the app (they know the adapters). Shape: { label, persist(row) -> any, after?(row,res), rollback?(row) }
const modifierHandlers = {};
addEventListener("online", () => queue.kick(200));
// Back in front: anything already due goes now, instead of waiting for a timer the system froze while the app was out of sight.
const kickIfDue = () => { if (!document.hidden && queue.pending().some((r) => r.notBefore <= Date.now())) queue.kick(300); };
document.addEventListener("visibilitychange", kickIfDue); addEventListener("focus", kickIfDue); addEventListener("pageshow", kickIfDue);
navigator.serviceWorker?.addEventListener?.("message", (e) => { if (e.data?.type === "drain") queue.kick(0); });
