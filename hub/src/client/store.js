/* store.js: the local mail store. IndexedDB holds every thread and message-metadata record in the
   sync window per account, bodies as an LRU, per-account sync state and a small meta store. An in-memory Map (state.threads)
   is the single source the UI renders from; IndexedDB is its durable copy. A tiny snapshot of the unified inbox lives in
   localStorage so the very first paint reads state synchronously, before IndexedDB has even opened. */
const idb = {
  db: null, VERSION: 4,
  // A request that never finishes used to park its caller for ever, and every path in the app awaits this store: the sync (so
  // state.loading stayed true and no refresh ever ran again), a notification tap, the import of mail FCM downloaded. Measured on
  // my Pixel 2026-10-03: four hours with nothing new on screen, the refresh button a no-op, a tapped conversation that
  // never opened, while the page, the bridge and the network all worked. A conversation tapped in the list changed its title and
  // then sat on the PREVIOUS body: openThread was parked on its body-cache read, before the network fallback that shows
  // "Loading…". So every request (and open) is now watched. One that spends STALL_MS of AWAKE time unfinished marks the store
  // stalled: every waiter is released with an error, the connection is abandoned (close() would wait on the very transactions
  // that are stuck), and the page carries on storeless: the mode it already had for a database that never opened.
  STALL_MS: 15_000, UPGRADE_MS: 120_000, stalled: null, onStall: null, waiting: new Set(), ticker: null,
  watch(w) {
    w.age = 0; this.waiting.add(w);
    if (this.ticker) return;
    let last = performance.now();
    const tick = () => {
      const now = performance.now(), dt = now - last; last = now;
      // Only awake time counts. A late tick means this page was frozen (Android's app freezer stops the app and its WebView
      // renderer between pushes), suspended, or throttled in the background, and IndexedDB stopped with it. Charging that gap
      // would convict a store that is fine the moment the process thaws.
      const awake = dt < 2500 ? dt : 0;
      for (const p of this.waiting) p.age += awake;
      // A schema upgrade backfills indexes over every row, so slow is not stuck, but it gets a long budget, not an endless one, or a
      // wedged upgrade would hold boot for ever.
      if ([...this.waiting].some((p) => p.age >= (p.upgrading ? this.UPGRADE_MS : this.STALL_MS))) this.stall();
      this.ticker = this.waiting.size ? setTimeout(tick, 1000) : null;
    };
    this.ticker = setTimeout(tick, 1000);
  },
  stall() {
    const worst = [...this.waiting].sort((a, b) => b.age - a.age)[0] || {};
    const info = { at: Date.now(), what: worst.what || "?", age: Math.round(worst.age || 0), waiting: this.waiting.size };
    const db = this.db; this.db = null; try { db && db.close(); } catch (_) {}
    for (const p of [...this.waiting]) p.expire();
    if (this.stalled) return;
    this.stalled = info;
    try { this.onStall && this.onStall(info); } catch (_) {}
  },
  open() { return new Promise((res, rej) => { const q = indexedDB.open("mailhub", this.VERSION);
    let done = false; const w = { what: "open", expire: () => fin(rej, Object.assign(new Error("IndexedDB did not open"), { stalled: true })) };
    const fin = (f, v) => { if (done) return false; done = true; this.waiting.delete(w); f(v); return true; };
    this.watch(w);
    q.onupgradeneeded = () => { w.upgrading = true; const d = q.result; for (const s of ["threads", "messages", "bodies", "meta", "state", "queue"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: s === "meta" ? "k" : "key" }); const m = q.transaction.objectStore("messages"); if (!m.indexNames.contains("threadKey")) m.createIndex("threadKey", "threadKey"); if (!m.indexNames.contains("account")) m.createIndex("account", "account");
    // v4: `bodies` never had this index, so cachedThread()'s getByIndex("bodies", "threadKey", …) threw NotFoundError on every
    // call, was swallowed by its catch, and returned []: the body cache was WRITE-ONLY. Every conversation opened went to the
    // network even when its body was already sitting in this store, and evictBodies dutifully LRU-evicted a cache nothing read.
    // createIndex backfills existing rows, so the bodies already stored become readable the moment this upgrade runs.
    const b = q.transaction.objectStore("bodies"); if (!b.indexNames.contains("threadKey")) b.createIndex("threadKey", "threadKey"); }; q.onsuccess = () => {
      if (done) { try { q.result.close(); } catch (_) {} return; }   // answered after the watchdog gave up on it: the session is storeless now
      this.db = q.result;
      // Another connection (a second tab, or the service worker's version-less open) must not be able to wedge a LATER upgrade:
      // without this the holder blocks it, open() rejects on onblocked, boot swallows that, and the whole session then runs with
      // this.db === null: no cached threads, no body cache, and no durable action queue.
      // The v4 bump is what makes it live, because that upgrade now runs once on every device.
      this.db.onversionchange = () => { try { this.db.close(); } catch (_) {} this.db = null; };
      fin(res); };
      q.onerror = () => fin(rej, q.error);
      q.onblocked = () => fin(rej, Object.assign(new Error("indexeddb blocked"), { blocked: true })); }); },
  // One retry, because the common blocker is transient: the worker holds the database open for a single put and closes it within
  // milliseconds. Retrying beats booting storeless.
  async openWithRetry(waitMs = 1200) {
    try { return await this.open(); }
    catch (e) { if (!e || !e.blocked) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
      return await this.open(); }
  },
  req(store, mode, fn) { return new Promise((res, rej) => { if (!this.db) return res(undefined); let r, t; try { t = this.db.transaction(store, mode); r = fn(t.objectStore(store)); } catch (e) { return rej(e); }
    let done = false; const t0 = performance.now();
    const fin = (f, v) => { if (done) return; done = true; this.waiting.delete(w); f(v);
      const ms = performance.now() - t0; if (ms > 2000 && typeof perf !== "undefined") perf.record("idb:slow " + w.what, ms); };   // what STALL_MS is sized against, measured on the device
    const w = { what: `${mode} ${store}`, expire: () => { try { t.abort(); } catch (_) {} fin(rej, Object.assign(new Error("IndexedDB did not answer"), { stalled: true })); } };
    this.watch(w);
    t.oncomplete = () => fin(res, r && "result" in r ? r.result : r); t.onerror = () => fin(rej, t.error); t.onabort = () => fin(rej, t.error); }); },
  async getAll(store) { try { return (await this.req(store, "readonly", (s) => s.getAll())) || []; } catch (_) { return []; } },
  async get(store, key) { try { return await this.req(store, "readonly", (s) => s.get(key)); } catch (_) { return undefined; } },
  // Many keys, one transaction: the history loop read and wrote one message per label change, in turn; 30 changes cost 18 ms
  // against 1 ms batched on the Mac's own WebKit with an on-disk store. Results come back in key order; a missing or
  // unreadable key is undefined, as get() would give.
  async getMany(store, keys) { if (!keys.length) return []; const out = new Array(keys.length); try { await this.req(store, "readonly", (s) => { keys.forEach((k, i) => { const q = s.get(k); q.onsuccess = () => { out[i] = q.result; }; }); }); } catch (_) {} return out; },
  async getByIndex(store, index, value) { try { return (await this.req(store, "readonly", (s) => s.index(index).getAll(value))) || []; } catch (_) { return []; } },
  async putAll(store, rows) { if (!rows.length) return; try { await this.req(store, "readwrite", (s) => { for (const r of rows) s.put(r); }); } catch (e) { console.warn("idb put", store, e); } },
  async putAllStrict(store, rows) { if (!rows.length) return; if (!this.db) throw new Error("no local store"); await this.req(store, "readwrite", (s) => { for (const r of rows) s.put(r); }); }, // throws: callers that need durability check it; including a storeless session, where nothing written survives a restart
  async del(store, key) { try { await this.req(store, "readwrite", (s) => s.delete(key)); } catch (_) {} },
  async delAll(store, keys) { if (!keys.length) return; try { await this.req(store, "readwrite", (s) => { for (const k of keys) s.delete(k); }); } catch (_) {} },
  async clear(store) { try { await this.req(store, "readwrite", (s) => s.clear()); } catch (_) {} },
  async count(store) { try { return await this.req(store, "readonly", (s) => s.count()); } catch (_) { return 0; } },
  async meta(k, v) { if (v === undefined) return (await this.get("meta", k))?.v; await this.putAll("meta", [{ k, v }]); },
  async wipe() { try { this.db && this.db.close(); } catch (_) {} await new Promise((res) => { const r = indexedDB.deleteDatabase("mailhub"); r.onsuccess = r.onerror = r.onblocked = () => res(); }); try { localStorage.removeItem("mh:snapshot"); } catch (_) {} },
};

// ---- snapshot for the synchronous first paint (top of the unified inbox, small) ----
const snapshot = {
  read() { try { const s = localStorage.getItem("mh:snapshot"); if (!s) return null; const j = JSON.parse(s); return Array.isArray(j.threads) ? j : null; } catch (_) { return null; } },
  // rev = the newest change this window knows of; a window that has not seen a newer change must not overwrite the snapshot
  write(threads, extra = {}) { try { const rev = threads.reduce((m, t) => Math.max(m, t.updatedAt || 0), 0); const cur = this.read(); if (cur && (cur.rev || 0) > rev) return false; const rows = threads.filter((t) => t.state === "inbox").sort((a, b) => b.date - a.date).slice(0, 150).map((t) => ({ ...t, _snap: 1 })); localStorage.setItem("mh:snapshot", JSON.stringify({ at: Date.now(), rev, threads: rows, ...extra })); return true; } catch (_) { return false; } },
};

// ---- thread derivation from message metadata (Gmail) ----
// The messages of a conversation that Gmail's own Inbox shows. Gmail lists a conversation in the Inbox when ANY message in it is
// there and hides the trashed or spam ones inside it; only a conversation whose every message is trashed (or spam) sits in Trash.
// Sherit called the whole conversation trashed when ANY message was, so a new Venmo or Cash App code arriving in a conversation
// whose older codes had been deleted never reached the inbox (reported 2026-10-04).
const binned = (labels) => (labels || []).includes("TRASH") || (labels || []).includes("SPAM");
function shownMessages(msgs, labelsOf = (m) => m.labels) { const live = msgs.filter((m) => !binned(labelsOf(m))); return live.length ? live : msgs; }
// The messages of a LIVE conversation that sit in Trash, or null. Hidden from the conversation above, they were reachable in no Sherit
// view: the Trash list matched only a conversation whose every message is trashed. The
// list row carries their ids so Trash lists the conversation and opens it on them, and Restore knows to untrash.
function trashedIds(all, shown, labelsOf = (m) => m.labels) { if (shown.length >= all.length) return null; const ids = all.filter((m) => (labelsOf(m) || []).includes("TRASH")).map((m) => m.id); return ids.length ? ids : null; }
function deriveGmailThread(email, threadId, msgs, { snoozed = false } = {}) {
  const all = [...msgs].sort((a, b) => a.date - b.date); const sorted = shownMessages(all); const first = sorted[0], last = sorted[sorted.length - 1];
  const labels = new Set(); for (const m of sorted) for (const l of m.labels || []) labels.add(l);
  const lastIn = [...sorted].reverse().find((m) => !(m.labels || []).includes("SENT")) || last;
  const out = (last.labels || []).includes("SENT");
  const st = labels.has("TRASH") ? "trash" : labels.has("SPAM") ? "spam" : labels.has("INBOX") ? "inbox" : snoozed ? "snoozed" : "archived"; // labels are the SHOWN messages', so TRASH/SPAM here means every message is binned; Gmail's own spam verdict is honoured: hidden everywhere except the Spam folder
  const unsubMsg = [...sorted].reverse().find((m) => !(m.labels || []).includes("SENT") && m.unsub) || null; // newest inbound message that carries List-Unsubscribe (a newer one without it must not hide the list); unsubKnown = every inbound record was synced with the header captured
  return { key: `${email}|${threadId}`, account: email, kind: "gmail", id: threadId, subject: first.subject || last.subject || "(no subject)", snippet: last.snippet || "", from: lastIn.from || last.from, fromAddr: lastIn.fromAddr || last.fromAddr, fromName: out ? "You" : (lastIn.fromName || last.fromName), to: last.to || "", identity: email, out, date: last.date, unread: labels.has("UNREAD"), starred: labels.has("STARRED"), state: st, labels: [...labels], cat: lastIn.cat || last.cat || "personal", count: sorted.length, shownIds: sorted.length < all.length ? sorted.map((m) => m.id) : null, binnedIds: trashedIds(all, sorted), lastMsgId: last.id, msgIdHdr: last.msgIdHdr || "", msgIds: all.map((m) => m.msgIdHdr).filter(Boolean), hasAtt: sorted.some((m) => m.hasAtt), unsub: unsubMsg ? unsubMsg.unsub : "", unsubPost: unsubMsg ? (unsubMsg.unsubPost || "") : "", unsubKnown: sorted.every((m) => (m.labels || []).includes("SENT") || m.unsub !== undefined), updatedAt: Date.now() };
}

// ---- search operators: Gmail's (support.google.com/mail/answer/7190), read the same way on every path ----
// parseSearch takes the operators out of a query and leaves its words (quoted phrases, -word, from:/to:/subject:/body:/account:) for
// the device index, the row scan and the hub's word match; the rows are then filtered by the operators. Sherit's own names are taken
// too (Done is Archive, Pins are stars) and turned into Gmail's by serverQuery, with every date as epoch seconds: Gmail reads a calendar
// date as midnight somewhere else, and is:pinned or has:attachments as words (measured in November 2026). A token that is not one of these
// stays a word, as before. index.js searchQuery is this function, for the hub's own search; test/searchops.mjs holds the two together.
const SEARCH_IN = { inbox: "inbox", archive: "archived", archived: "archived", done: "archived", trash: "trash", bin: "trash", spam: "spam", junk: "spam", sent: "sent", snoozed: "snoozed", anywhere: "anywhere", all: "anywhere" };
const SEARCH_IS = { unread: ["unread", "read"], read: ["read", "unread"], starred: ["starred", "unstarred"], pinned: ["starred", "unstarred"] };
const SEARCH_GMAIL = { inbox: "in:inbox", archived: "in:archive", trash: "in:trash", spam: "in:spam", sent: "in:sent", snoozed: "in:snoozed", anywhere: "in:anywhere", unread: "is:unread", read: "is:read", starred: "is:starred", unstarred: "-is:starred", att: "has:attachment", noatt: "-has:attachment" };
function searchWhen(v, now) {   // a date as the ms of its midnight on this device (the Worker's clock is UTC), epoch seconds, or Nd/Nm/Ny ago
  let m = /^(\d{9,11})$/.exec(v); if (m) return Number(m[1]) * 1000;
  let y = 0, mo = 0, d = 0;
  if ((m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [y, mo, d] = [+m[3], +m[1], +m[2]];   // Gmail's 04/16/2004
  if (y) { const t = new Date(y, mo - 1, d); return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : null; }
  m = /^(\d{1,4})([dmy])$/i.exec(v); if (m) { const n = +m[1], t = new Date(now); if (/d/i.test(m[2])) t.setDate(t.getDate() - n); else if (/m/i.test(m[2])) t.setMonth(t.getMonth() - n); else t.setFullYear(t.getFullYear() - n); return t.getTime(); }
  return null;
}
function parseSearch(q, now = Date.now()) {
  const s = { text: "", in: [], notIn: [], want: [], after: null, before: null, ops: false }; const words = [];
  for (const m of String(q || "").matchAll(/(?:[a-z]+:)?"[^"]*"|\S+/gi)) {
    const tok = m[0], o = /^(-?)(in|is|has|after|before|newer|older|newer_than|older_than):(.+)$/i.exec(tok);
    const neg = !!(o && o[1]), op = o ? o[2].toLowerCase() : "", v = o ? o[3].toLowerCase() : "";
    if (op === "in" && SEARCH_IN[v]) (neg ? s.notIn : s.in).push(SEARCH_IN[v]);
    else if (op === "is" && SEARCH_IS[v]) s.want.push(SEARCH_IS[v][neg ? 1 : 0]);
    else if (op === "has" && (v === "attachment" || v === "attachments")) s.want.push(neg ? "noatt" : "att");
    else if (op && op !== "in" && op !== "is" && op !== "has" && searchWhen(v, now) != null && (/_than$/.test(op) === /^\d{1,4}[dmy]$/.test(v))) {
      const at = searchWhen(v, now), late = (op === "after" || op === "newer" || op === "newer_than") !== neg;   // -after: is before:
      if (late) s.after = s.after == null ? at : Math.max(s.after, at); else s.before = s.before == null ? at : Math.min(s.before, at);
    } else { words.push(tok); continue; }
    s.ops = true;
  }
  s.text = words.join(" ");
  return s;
}
// The query the servers get: the words as typed, then each operator in Gmail's own spelling. The hub's searchQuery reads this form too.
function serverQuery(q, now = Date.now()) {
  const s = parseSearch(q, now); if (!s.ops) return String(q || "").trim();
  return [s.text, ...s.in.map((v) => SEARCH_GMAIL[v]), ...s.notIn.map((v) => "-" + SEARCH_GMAIL[v]), ...s.want.map((v) => SEARCH_GMAIL[v]),
    ...(s.after != null ? ["after:" + Math.floor(s.after / 1000)] : []), ...(s.before != null ? ["before:" + Math.ceil(s.before / 1000)] : [])].filter(Boolean).join(" ");
}

// ---- cross-window bus: every window of the origin shares IndexedDB but renders from its own memory. Local changes, queue rows and
// recently persisted keys are announced so a stale window neither shows nor writes back an older view (2026-09-10 resurrection fix).
const bus = { ch: null, handlers: [] };
function busOpen() { if (bus.ch || typeof BroadcastChannel === "undefined") return; try { bus.ch = new BroadcastChannel("mh"); bus.ch.onmessage = (e) => { for (const h of bus.handlers) { try { h(e.data || {}); } catch (_) {} } }; } catch (_) {} }
function broadcast(msg) { busOpen(); try { bus.ch?.postMessage(msg); } catch (_) {} }
function onBroadcast(h) { busOpen(); bus.handlers.push(h); }
