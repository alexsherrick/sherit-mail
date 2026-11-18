/* Sherit Mail service worker: app shell cache, push notifications, badge. Version is injected by the Worker. */
const VERSION = "__VERSION__";
const SHELL = "shell-arc1-" + VERSION;
const SHELL_URLS = ["/", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png?v=ghost1", "/icons/icon-512.png?v=ghost1", "/search.worker.js"];
const STATIC_URLS = ["/sqlite3.mjs", "/sqlite3.wasm"]; // big and immutable: cached on first use

// cache.addAll is ATOMIC: one failing URL leaves the ENTIRE cache empty, and the old code swallowed that with `.catch( => {})`.
// Verified in a real browser 2026-09-18: a three-URL list where one 404s produced a cache with ZERO entries, while the same list
// without it cached fine. Six URLs fetched over a mobile connection is six chances to lose the whole shell for a whole version,
// after which every launch goes to the network for the document. That is exactly the shape of "the app takes a second to open".
// Each entry is now cached independently, so one bad fetch costs one entry instead of all of them.
// (Also verified the same day: `cache-control: no-store` does NOT prevent Cache API storage; the shell caches fine despite it.)
async function precache(c) {
  const failed = [];
  await Promise.all(SHELL_URLS.map(async (u) => {
    try {
      const r = await fetch(u, { credentials: "same-origin" });
      if (!r.ok) throw new Error(u + " HTTP " + r.status);
      // A signed-out "/" is also a 200: the sign-in page. The fetch handler already refuses to cache it as the shell; install
      // must refuse too, or a session that lapsed between page load and worker install would bake the login page in as the app.
      if (new URL(u, location.origin).pathname === "/" && r.headers.get("x-app-shell") !== "1") throw new Error("/ was not the app shell");
      await c.put(u, r.clone());
    } catch (err) { failed.push(String(err && err.message || err)); }
  }));
  return failed;
}
// install runs while the OLD worker is still serving, so this is the moment to get the new shell warm. skipWaiting() used to fire
// unconditionally, which meant a failed precache handed control to a worker whose cache was empty, and since `activate` then
// deleted the previous cache, every launch on the new version went to the network for the document.
const READY_URLS = ["/", "/app.js"];   // the two that decide whether a launch can be answered from cache at all
async function shellReady(c) {
  for (const u of READY_URLS) if (!(await c.match(u, { ignoreSearch: u === "/" }))) return false;
  return true;
}
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    let warm = false;
    try { const c = await caches.open(SHELL); self.__precacheFailed = await precache(c); warm = await shellReady(c); } catch (_) {}
    // Only take over when the replacement shell can actually answer. If it cannot, the old worker keeps serving its own warm
    // cache and the page's /api/version check brings the user across later: a slightly stale app beats a second of white.
    if (warm) await self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Navigation preload: the browser starts fetching the document IN PARALLEL with booting this worker. Opening an installed PWA
    // that has been idle means the worker is terminated and must be started before it can answer the navigation, and on my
    // phone the document did not arrive for 775 ms of an 881 ms first paint, i.e. 88% of the wait was the navigation
    // itself, not the app. Preload removes that serialisation for the case where the cache cannot answer.
    // Navigation preload was enabled here on 2026-09-18 and is deliberately NOT re-enabled. This app precaches `/` and serves it
    // cache-first, which is the case Chrome says does not need it: "the preloaded response will go to waste", and MDN is clear
    // the worker must boot before it can answer ANY event, cache included, so preload cannot shorten the path that actually runs.
    // It would have cost a wasted network request on every launch. Revisit only if cold-open data shows the miss path dominating.
    const c = await caches.open(SHELL);
    const warm = await shellReady(c);
    if (warm) { // never drop the last shell that works in favour of one that does not
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL && k !== "static-v1").map((k) => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;                 // Gmail API, images, POSTs: network only
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/sw.js") return;
  if (STATIC_URLS.includes(url.pathname)) { e.respondWith(caches.open("static-v1").then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }))); return; }
  const isShell = url.pathname === "/" || SHELL_URLS.includes(url.pathname) || url.pathname.startsWith("/icons/");
  if (!isShell) return;
  // Shell: cache first, refresh in the background (the page checks /api/version and reloads when a new shell is live).
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    // `/app.js` joins `/` in ignoring the query string. The page asks for `/app.js?v=<version>` while precache stored the
    // bare path, so an exact match could never hit and every new build fetched the bundle twice: once to precache, once
    // for the page. Safe because the cache NAME carries the build version: every entry in this cache is this build's.
    // Deliberately NOT extended to `/icons/…`, whose `?v=` is hand-rolled and outside the version hash.
    const hit = await c.match(e.request, { ignoreSearch: url.pathname === "/" || url.pathname === "/app.js" });
    const keep = (r) => { if (r && r.ok && (url.pathname !== "/" || r.headers.get("x-app-shell") === "1")) c.put(e.request, r.clone()); return r; };
    // The cache name carries the build version, so a hit is BY CONSTRUCTION already the current build. The old background
    // re-fetch behind every hit could therefore never find anything new: it was one wasted request per shell request, on every
    // launch, on mobile data. A new build arrives as a new worker, not as a refreshed entry.
    if (hit) return hit;
    try { return keep(await fetch(e.request)) || new Response("offline", { status: 503 }); } catch (_) { return new Response("offline", { status: 503 }); }
  })());
});
// A conversation already handled must not keep sitting in the shade. The store this app writes on this device is the truth here: the
// worker reads it directly (no network) when a push arrives and closes what is done. Keys handled on ANOTHER device ride along in the
// push payload as `dismiss`, so nothing extra is sent or requested for them.
function idbThreads(keys) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    setTimeout(() => fin(new Map()), 1500);
    try { const q = indexedDB.open("mailhub"); // no version: never triggers an upgrade from here
      q.onerror = () => fin(new Map());
      q.onsuccess = () => { const db = q.result;
        db.onversionchange = () => { try { db.close(); } catch (_) {} fin(new Map()); };
        if (!db.objectStoreNames.contains("threads")) return fin(new Map());
        const out = new Map(); const tx = db.transaction("threads", "readonly"); const st = tx.objectStore("threads");
        for (const k of keys) { const g = st.get(k); g.onsuccess = () => { if (g.result) out.set(k, g.result); }; }
        tx.oncomplete = () => { db.close(); fin(out); }; tx.onerror = () => { db.close(); fin(out); };
      };
    } catch (_) { fin(new Map()); }
  });
}
const isHandled = (t) => !!t && !(t.state === "inbox" && t.unread);
// Write one record into the version-less store (same rule as idbThreads: never trigger an upgrade from the worker).
// The worker cannot read localStorage, so a deliberate "Disable here" was invisible to the one re-subscription path that lives
// out here. The page mirrors the flag into meta.push_off for exactly this read.
function idbGetMeta(k) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    setTimeout(() => fin(undefined), 1500);
    try { const q = indexedDB.open("mailhub");
      q.onerror = () => fin(undefined); q.onblocked = () => fin(undefined);
      q.onsuccess = () => { const db = q.result;
        db.onversionchange = () => { try { db.close(); } catch (_) {} fin(undefined); };
        if (!db.objectStoreNames.contains("meta")) { db.close(); return fin(undefined); }
        let g; try { g = db.transaction("meta", "readonly").objectStore("meta").get(k); } catch (_) { db.close(); return fin(undefined); }
        g.onsuccess = () => { const v = g.result?.v; db.close(); fin(v); };
        g.onerror = () => { db.close(); fin(undefined); }; };
    } catch (_) { fin(undefined); }
  });
}
const PF_TTL = 24 * 3600e3;   // matches PUSHED_MAX_AGE in app.js
const PF_MAX = 20;            // newest N kept; a full Gmail thread each, so this is the storage bound
function idbPut(store, row) {
  return new Promise((res) => {
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    setTimeout(fin, 2000);
    try { const q = indexedDB.open("mailhub");
      q.onerror = () => fin();
      q.onblocked = () => fin();
      q.onsuccess = () => { const db = q.result;
        db.onversionchange = () => { try { db.close(); } catch (_) {} fin(); }; // never wedge the page's v3->v4 upgrade
        if (!db.objectStoreNames.contains(store)) { db.close(); return fin(); }
        let tx; try { tx = db.transaction(store, "readwrite"); } catch (_) { db.close(); return fin(); }
        const st = tx.objectStore(store); st.put(row);
        // Cap the stash here, in the same transaction that writes it: a device that never opens the app would otherwise keep one
        // full format=full thread per push for ever.
        try { const cur = st.openCursor(); const rows = [];
          cur.onsuccess = () => { const c = cur.result;
            if (c) { const k = String(c.value?.k || ""); if (k.startsWith("pf:")) rows.push({ k, at: c.value?.v?.at || 0 }); return c.continue(); }
            const now = Date.now();
            const dead = rows.filter((r) => !r.at || now - r.at > PF_TTL).map((r) => r.k);
            const live = rows.filter((r) => r.at && now - r.at <= PF_TTL).sort((a, b) => b.at - a.at);
            for (const r of live.slice(PF_MAX)) dead.push(r.k);
            for (const k of dead) if (k !== row.k) st.delete(k); };
        } catch (_) {}
        tx.oncomplete = () => { db.close(); fin(); }; tx.onerror = () => { db.close(); fin(); }; };
    } catch (_) { fin(); }
  });
}
// The mail should already be on the device when its notification comes. The notification text alone carries sender, subject and a line; the
// BODY used to be fetched only when the conversation was opened, so tapping meant a cold start THEN a network round trip, with
// "Loading…" in between. The worker is already awake at push time and the phone is not, so it downloads the conversation now and
// stashes the raw payload; app.js claims it (pushedThread) and renders from local bytes. Best-effort by construction: this runs
// after showNotification, and every failure is swallowed: a push must never be lost to a prefetch.
// Returns what happened, for the push census below: "stashed" is the only outcome that puts mail on the device.
async function prefetchThread(d) {
  if (navigator.connection?.saveData) return "skip: data saver";   // Data Saver: the same rule prefetchBodies follows in the page
  const key = `${d.account}|${d.thread}`;
  let raw = null;
  if (d.kind === "gmail") {
    const tr = await fetch(`/api/gmail/accounts/${encodeURIComponent(d.account)}/token`, { method: "POST", credentials: "include" });
    if (!tr.ok) return `token http ${tr.status}`; const tok = await tr.json(); if (!tok.access_token) return "token: none";
    const gr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(d.thread)}?format=full`,
      { headers: { authorization: "Bearer " + tok.access_token } });
    if (!gr.ok) return `gmail http ${gr.status}`; raw = await gr.json();
  } else {
    // keep_unread=1 or this prefetch MARKS THE CONVERSATION READ. GET /api/threads/:id clears `unread` unless asked not
    // to (hub/src/index.js), which is right when a person opens a thread and wrong when a background worker fetches one
    // for a notification the user has not looked at yet. The parameter existed for this and nothing passed it, so
    // every hub push quietly read its own mail, and sw.js's own isHandled() treats a read INBOX thread as handled,
    // which is the rule that closes notifications.
    const hr = await fetch(`/api/threads/${encodeURIComponent(d.thread)}?keep_unread=1`, { credentials: "include" });
    if (!hr.ok) return `hub http ${hr.status}`; raw = await hr.json();
  }
  if (!raw) return "empty";
  await idbPut("meta", { k: "pf:" + key, v: { kind: d.kind, account: d.account, id: d.thread, raw, at: Date.now() } });
  return "stashed";
}
// The push census. On 2026-10-02 the hub watched two notifications go out that both push services accepted, and the phone made NO
// request to the hub afterwards (no prefetch at all) and the page cannot tell why: the push arrived late (Android holds normal-
// urgency pushes in Doze), the worker saw a "visible" window and skipped, or a fetch failed. Each push now leaves one line (how late it arrived, what windows the worker saw, and what the prefetch did)
// which the Speed panel prints. Diagnostic only: it
// changes no behaviour, and a lost update between two concurrent pushes costs one line of a log, nothing else.
async function notePush(entry) {
  try { const prev = (await idbGetMeta("pushlog")) || []; await idbPut("meta", { k: "pushlog", v: [...prev.slice(-19), entry] }); } catch (_) {}
}
const ZERO_TAG = "s-zero";
// `extra` is what another device (or Gmail itself) reported as handled. It arrives either as bare keys, which is all the
// Worker sent earlier, or as {k, at} entries. The timestamp is a guard, not decoration: without it a dismissal
// can close a notification RAISED AFTER IT, so a reply landing in a thread trashed a moment earlier would vanish before it
// was ever seen. One second of slack absorbs clock skew between the two devices.
async function sweepNotifications(extra = []) {
  const reg = self.registration; if (!reg.getNotifications) return 0;
  const live = (await reg.getNotifications()).filter((n) => (n.tag || "").startsWith("t-"));
  const drop = new Set(), handledAt = new Map();
  for (const e of extra) { const k = typeof e === "string" ? e : e && e.k; if (!k) continue; drop.add("t-" + k); if (e && typeof e.at === "number") handledAt.set("t-" + k, e.at); }
  const ask = live.map((n) => n.tag.slice(2)).filter((k) => !drop.has("t-" + k));
  if (ask.length) { const rows = await idbThreads(ask); for (const [k, t] of rows) if (isHandled(t)) drop.add("t-" + k); }
  let closed = 0;
  for (const n of live) {
    if (!drop.has(n.tag)) continue;
    const when = handledAt.get(n.tag);
    if (when && n.timestamp && n.timestamp > when + 1000) continue;   // this notification is NEWER than the dismissal naming it
    n.close(); closed++;
  }
  // The placeholder is only ever the last thing standing: the moment anything real is on screen it has no job.
  const rest = await reg.getNotifications();
  if (rest.some((n) => n.tag !== ZERO_TAG)) for (const n of rest) if (n.tag === ZERO_TAG) n.close();
  return closed;
}
// A push handler may not finish with an empty shade. Chromium counts the notifications visible for this service worker AFTER
// the handler returns and, finding none, spends push budget; when that budget runs out it posts its own "This site has been
// updated in the background" instead (Chromium's push service: `if (notification_needed && !notification_shown)` spends
// budget, and maximum site engagement allows about 6 such pushes a day). So the last
// notification to go is REPLACED, never merely removed, which makes that branch unreachable and the budget spend zero.
// Silent so it cannot buzz, one fixed tag so it can never stack, and cleared by the next push, by opening the app, or by a tap.
async function ensureVisible(clients) {
  const reg = self.registration; if (!reg.getNotifications) return;
  if ((await reg.getNotifications()).length) return;
  // The one documented exemption: "The one scenario where you don't have to show a notification is when the user has your
  // site open and focused", which Chromium implements as IsTabVisible on the active tab of the
  // origin. The test below is deliberately
  // NARROWER than Chromium's (focused AND visible, where Chromium accepts visible alone) so whenever it passes the
  // browser's own test has certainly passed too. It is what keeps "All caught up" off the Mac while the user is using it.
  if ((clients || []).some((c) => c.focused && c.visibilityState === "visible")) return;
  await reg.showNotification("mailhub", { tag: ZERO_TAG, body: "All caught up", icon: "/icons/icon-192.png?v=ghost1", badge: "/icons/badge-96.png?v=ghost1", silent: true, renotify: false, data: { url: "/", kind: "zero" } });
}
self.addEventListener("push", (e) => {
  const arrivedAt = Date.now();   // stamped first: the census's "late by" is delivery delay, not delivery plus the download below
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "mailhub", body: e.data ? e.data.text() : "" }; }
  const title = d.title || "Mail";
  // Title = sender, body = subject + a line of the message (built by the Worker per the preview setting). One notification per thread:
  // a follow-up in the same thread replaces it. Buttons show where the platform draws them (Android Chrome); macOS system
  // notifications show icon, title and body only.
  const tag = d.thread ? `t-${d.account}|${d.thread}` : (d.kind === "gmail" || d.kind === "imap" || d.kind === "hub") ? `${d.kind}-${d.account}` : (d.kind || "mail");
  const opts = { body: d.body || "", icon: "/icons/icon-192.png?v=ghost1", badge: "/icons/badge-96.png?v=ghost1", tag, renotify: !!d.priority, timestamp: (d.at && Date.parse(d.at)) || Date.now(), data: { url: d.url || "/", kind: d.kind, account: d.account, thread: d.thread }, silent: false };
  if (d.thread && ["gmail", "hub", "imap"].includes(d.kind)) opts.actions = [{ action: "done", title: "Done" }, { action: "read", title: "Mark read" }];
  e.waitUntil((async () => {
    if (d.kind !== "dismiss") await self.registration.showNotification(title, opts);
    try { await sweepNotifications(Array.isArray(d.dismiss) ? d.dismiss : []); } catch (_) {}
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    try { await ensureVisible(clients); } catch (_) {}   // never finish this handler with nothing on screen: see ensureVisible
    for (const c of clients) c.postMessage({ type: "push", data: d });
    // Last, and only once the notification is safely up: pull the conversation down so it is already here when the tap comes.
    // An open window fetches and caches it itself, so this is for the case that matters: the app closed and the phone asleep.
    // "no client" was the wrong test: Android keeps an installed PWA's window in clients.matchAll while it is backgrounded and
    // FROZEN, so the worker skipped the prefetch and the frozen page never ran its own idle prefetch either: nobody fetched it,
    // in exactly the phone-in-a-pocket case this feature exists for. A VISIBLE page will prefetch on its own; anything else will
    // not. R39 tracks that.
    const visible = clients.some((c) => c.visibilityState === "visible");
    let pf = "n/a";
    if (d.thread && ["gmail", "hub", "imap"].includes(d.kind)) {
      if (visible) pf = "skip: a window is visible";
      else { try { pf = await prefetchThread(d); } catch (e) { pf = "error: " + String((e && e.message) || e).slice(0, 60); } }
    }
    await notePush({ at: arrivedAt, sentAt: d.at ? Date.parse(d.at) || null : null, kind: d.kind || "", windows: clients.length,
      visible: clients.filter((c) => c.visibilityState === "visible").length, focused: clients.filter((c) => c.focused).length, pf });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close(); const data = e.notification.data || {};
  if (e.action === "done" || e.action === "read") { // acted from the notification: the Worker applies it, open tabs refresh
    e.waitUntil((async () => {
      let endpoint = null; try { endpoint = (await self.registration.pushManager.getSubscription())?.endpoint || null; } catch (_) {}
      try { await fetch("/api/notify/act", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: data.account, thread: data.thread, action: e.action, endpoint }) }); } catch (_) {}
      for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage({ type: "push", data: { account: data.account } });
      try { await sweepNotifications(data.thread ? [`${data.account}|${data.thread}`] : []); } catch (_) {}
    })()); return;
  }
  const url = new URL(data.url || "/", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
    for (const c of list) { if ("focus" in c) { await c.focus(); c.postMessage({ type: "open", url }); return; } }
    return self.clients.openWindow(url);
  }));
});
// A push service can rotate or drop this device's subscription on its own (a browser update, storage pressure, its own schedule).
// Nothing else on the device notices: the old endpoint is already dead, the hub deletes that row the first time it answers 410, and
// the app may not be opened for days, so push would stay silently off for good, which is exactly what mail that stops arriving
// on its own looks like. This is the one moment the platform tells anybody, so the worker re-subscribes and re-registers here.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    if (await idbGetMeta("push_off")) return;   // notifications were switched off by hand: do not quietly bring them back
    const old = e.oldSubscription || null;
    if (old?.endpoint) try { await fetch("/api/push/subscribe", { method: "DELETE", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: old.endpoint }) }); } catch (_) {}
    let sub = e.newSubscription || null;   // some browsers hand over the replacement; the rest expect the worker to ask for one
    if (!sub) {
      let key = old?.options?.applicationServerKey || null; // an ArrayBuffer, which subscribe() takes as-is
      if (!key) try { const c = await (await fetch("/api/push/config", { credentials: "include" })).json();
        if (c.public_key) key = Uint8Array.from(atob(c.public_key.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)); } catch (_) {}
      if (!key) return;
      try { sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); } catch (_) { return; }
    }
    try { await fetch("/api/push/subscribe", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), ua: navigator.userAgent, caps: ["dismiss2"] }) }); } catch (_) {}
  })());
});
self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting();
  else if (e.data && e.data.type === "dismiss") e.waitUntil?.(sweepNotifications(e.data.keys || [])); });
self.addEventListener("sync", (e) => { if (e.tag === "mh-drain") e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => { for (const c of cs) c.postMessage({ type: "drain" }); })); });
