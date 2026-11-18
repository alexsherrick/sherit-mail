// Push receipts for the service worker: a push service can rotate or drop this device's subscription, and until 2026-09-17 nothing
// listened: the hub pruned the dead endpoint on its first 410 and push stayed silently off for good. sw.js is loaded into a fake
// ServiceWorkerGlobalScope and its handlers are driven directly. Usage: node test/push.cjs
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../src/client/sw.js", "utf8").replace("__VERSION__", "test");
const fails = [];
const check = (cond, msg) => { console.log((cond ? "ok   " : "FAIL ") + msg); if (!cond) fails.push(msg); };

const SHELL_LIKE = /^(\/$|\/app\.js|\/manifest|\/icons\/|\/search\.worker)/;
function boot({ subscribeResult = null, subscribeThrows = false, config = { public_key: "QUJD" }, threadRaw, gmailOk = true, tokenOk = true, metaPushOff = 0, shellFetch = null, shade = null, threads = null, patch = null, windows = [] } = {}) {
  const calls = [];
  const wrote = [];
  const fakeDb = { objectStoreNames: { contains: () => true }, close() {},
    transaction: (_s, _m) => { const tx = { objectStore: () => ({
      put: (row) => wrote.push(row),
      delete: (k) => wrote.push({ deleted: k }),
      openCursor: () => { const c = {}; setTimeout(() => c.onsuccess && c.onsuccess(), 0); return c; },
      get: (k) => { const g = {}; setTimeout(() => { g.result = k === "push_off" && metaPushOff ? { k, v: metaPushOff } : (threads && threads[k]) || undefined; g.onsuccess && g.onsuccess(); }, 0); return g; },
    }) }; setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); return tx; } };
  const listeners = {};
  const sub = (endpoint) => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }) });
  const scope = {
    addEventListener: (t, fn) => (listeners[t] = fn),
    registration: {
      showNotification: async (title, opts) => { calls.push({ show: title, tag: opts.tag });
        if (!shade) return;
        const i = shade.findIndex((n) => n.tag === opts.tag); if (i >= 0) shade.splice(i, 1);
        shade.push({ title, tag: opts.tag, timestamp: opts.timestamp || Date.now(), silent: !!opts.silent, data: opts.data || {}, close() { const j = shade.indexOf(this); if (j >= 0) shade.splice(j, 1); } }); },
      getNotifications: async () => (shade ? shade.slice() : []),
      navigationPreload: { enable: async () => calls.push({ preloadEnabled: true }) },
      pushManager: {
        subscribe: async (opts) => { calls.push({ subscribe: true, key: opts.applicationServerKey }); if (subscribeThrows) throw new Error("denied"); return subscribeResult || sub("https://fcm.googleapis.com/fresh"); },
      },
    },
    clients: { matchAll: async () => windows, claim: async () => calls.push({ claimed: true }) },
    skipWaiting: () => calls.push({ skipWaiting: true }),
  };
  const fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || "GET", body: o.body ? JSON.parse(o.body) : null });
    if (url === "/api/push/config") return { json: async () => config };
    if (shellFetch && SHELL_LIKE.test(String(url))) return shellFetch(String(url));
    if (url.includes("/token")) return { ok: tokenOk, status: tokenOk ? 200 : 401, json: async () => ({ access_token: "at-1", expires_at: "2099-01-01" }) };
    if (url.startsWith("https://gmail.googleapis.com/")) return { ok: gmailOk, status: gmailOk ? 200 : 500, json: async () => threadRaw };
    if (url.startsWith("/api/threads/")) return { ok: true, status: 200, json: async () => threadRaw };
    return { ok: true, status: 200, json: async () => ({ ok: true, id: "sub-1" }) };
  };
  const cached = [];
  const store = new Map();
  const sandbox = { self: scope, fetch,
    // a real little cache: shellReady() asks it back for what precache() put in, so "warm" has to actually mean warm
    caches: { open: async () => ({ addAll: async () => {}, put: async (req, res) => { cached.push(String(req)); store.set(String(req), res); },
        match: async (req) => store.get(String(req)) || null }), keys: async () => [], delete: async () => true },
    URL, Promise,
    indexedDB: { open: () => { const q = { result: fakeDb }; setTimeout(() => q.onsuccess && q.onsuccess(), 0); return q; } },
    navigator: { userAgent: "test-agent" }, atob: globalThis.atob, Uint8Array, location: { origin: "https://mail.yourdomain.example" }, console,
    // sw.js guards its IndexedDB work with timeouts; without these in the sandbox the promise rejects and the write is silently lost
    setTimeout, clearTimeout };
  const vm = require("vm"); vm.createContext(sandbox);
  Object.assign(sandbox, { addEventListener: scope.addEventListener });
  vm.runInContext(patch ? patch(src) : src, sandbox);
  return { listeners, calls, scope, sub, wrote, cached };
}
// a missing handler is the defect itself, not a crash: report it and let the rest of the checks still run
const fire = async (listeners, type, ev) => { const fn = listeners[type]; if (!fn) { fails.push(`no ${type} handler`); return; } let p; await fn({ ...ev, waitUntil: (x) => (p = x) }); await p; };

(async () => {
  check(/pushsubscriptionchange/.test(src), "sw.js listens for pushsubscriptionchange at all (it did not before 2026-09-17)");

  { // the browser hands over the replacement subscription
    const { listeners, calls, sub } = boot();
    await fire(listeners, "pushsubscriptionchange", { oldSubscription: sub("https://fcm.googleapis.com/old"), newSubscription: sub("https://fcm.googleapis.com/new") });
    const del = calls.find((c) => c.method === "DELETE"), post = calls.find((c) => c.method === "POST");
    check(!!del && del.body.endpoint === "https://fcm.googleapis.com/old", `the dead endpoint is withdrawn — ${JSON.stringify(del && del.body)}`);
    check(!!post && post.url === "/api/push/subscribe" && post.body.subscription.endpoint === "https://fcm.googleapis.com/new", `the replacement is registered — ${JSON.stringify(post && post.body.subscription)}`);
    check(!calls.some((c) => c.subscribe), "it did not ask for a second subscription it was already given");
  }
  { // the browser drops it and hands over nothing: the worker must ask for a new one, keyed from the old subscription
    const { listeners, calls } = boot();
    const old = { endpoint: "https://fcm.googleapis.com/old", options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer } };
    await fire(listeners, "pushsubscriptionchange", { oldSubscription: old, newSubscription: null });
    check(calls.some((c) => c.subscribe && c.key === old.options.applicationServerKey), "it re-subscribes with the key the old subscription carried");
    const post = calls.find((c) => c.method === "POST");
    check(!!post && post.body.subscription.endpoint === "https://fcm.googleapis.com/fresh", `the fresh subscription reaches the hub — ${JSON.stringify(post && post.body.subscription)}`);
    check(post && post.body.ua === "test-agent", "it identifies the device");
  }
  { // nothing to key from: the worker asks the hub for the VAPID public key
    const { listeners, calls } = boot();
    await fire(listeners, "pushsubscriptionchange", { oldSubscription: null, newSubscription: null });
    check(calls.some((c) => c.url === "/api/push/config"), "with no key to hand it asks the hub for the VAPID key");
    check(calls.some((c) => c.subscribe), "and subscribes with it");
    check(calls.some((c) => c.method === "POST" && c.url === "/api/push/subscribe"), "and registers the result");
  }
  { // a refused re-subscribe must not throw out of the handler
    const { listeners, calls } = boot({ subscribeThrows: true });
    let threw = null; try { await fire(listeners, "pushsubscriptionchange", { oldSubscription: null, newSubscription: null }); } catch (e) { threw = e; }
    check(!threw, `a refused re-subscribe is survived, not thrown — ${threw && threw.message}`);
    check(!calls.some((c) => c.method === "POST" && c.url === "/api/push/subscribe"), "and nothing bogus is registered");
  }
  { // the push handler itself is untouched
    const { listeners, calls } = boot();
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "18f", title: "Alice", body: "Lunch?" }) } });
    check(calls.some((c) => c.show === "Alice" && c.tag === "t-a@gmail.com|18f"), "regression: a mail push still raises one notification per thread");
  }
  { // the conversation is pulled down at push time, so tapping the notification does not wait on the network
    const RAW = { id: "18f", messages: [{ id: "m1", internalDate: "1700000000000", payload: { headers: [{ name: "From", value: "Alice <a@x.com>" }] } }] };
    const { listeners, calls, wrote } = boot({ threadRaw: RAW });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "18f", title: "Alice", body: "Lunch?" }) } });
    const shownAt = calls.findIndex((c) => c.show);
    const tokenAt = calls.findIndex((c) => String(c.url).includes("/token"));
    const got = calls.find((c) => String(c.url).startsWith("https://gmail.googleapis.com/"));
    check(shownAt >= 0 && tokenAt > shownAt, "the notification is shown BEFORE any prefetch is attempted");
    check(!!got && String(got.url).includes("threads/18f") && String(got.url).includes("format=full"), `the pushed conversation is fetched in full — ${got && got.url}`);
    const row = wrote.find((r) => r.k === "pf:a@gmail.com|18f");
    check(!!row && row.v.raw && row.v.raw.id === "18f", "and stashed where the app will claim it (meta pf:<account>|<thread>)");
    check(!!row && typeof row.v.at === "number", "with the time it was fetched, so a stale one can be discarded");
  }
  { // a VISIBLE window fetches and caches the conversation itself: the worker must not duplicate that work
    const { listeners, calls, scope } = boot({ threadRaw: { id: "18f", messages: [] } });
    scope.clients.matchAll = async () => [{ postMessage() {}, visibilityState: "visible" }];
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "18f", title: "Alice" }) } });
    check(!calls.some((c) => String(c.url).startsWith("https://gmail.googleapis.com/")), "with the app VISIBLE, no duplicate prefetch is made");
  }
  { // …but a backgrounded/frozen PWA still appears in clients.matchAll and will NOT prefetch for itself. This is the phone-in-a-
    // pocket case the feature exists for, and the old `!clients.length` test skipped it.
    const { listeners, calls, scope } = boot({ threadRaw: { id: "18f", messages: [{ id: "m1", internalDate: "1", payload: {} }] } });
    scope.clients.matchAll = async () => [{ postMessage() {}, visibilityState: "hidden" }];
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "18f", title: "Alice" }) } });
    check(calls.some((c) => String(c.url).startsWith("https://gmail.googleapis.com/")), "a HIDDEN (backgrounded, possibly frozen) window does NOT suppress the prefetch");
  }
  { // cache.addAll is atomic: one bad URL used to leave the WHOLE shell cache empty, silently, for a whole version
    const res = (ok, hdr = {}) => ({ ok, status: ok ? 200 : 404, headers: { get: (k) => hdr[k.toLowerCase()] ?? null }, clone() { return this; } });
    const { listeners, cached } = boot({ shellFetch: (u) => (u === "/search.worker.js" ? res(false) : res(true, u === "/" ? { "x-app-shell": "1" } : {})) });
    await fire(listeners, "install", {});
    check(cached.includes("/") && cached.includes("/app.js"), `one failing shell URL no longer empties the cache — cached ${cached.length}: ${cached.join(", ")}`);
    check(!cached.includes("/search.worker.js"), "and the entry that actually failed is the only one missing");
  }
  { // a signed-out "/" is ALSO a 200 (the sign-in page); baking it in as the shell would show a login screen from cache for ever
    const res = (ok, hdr = {}) => ({ ok, status: ok ? 200 : 404, headers: { get: (k) => hdr[k.toLowerCase()] ?? null }, clone() { return this; } });
    const { listeners, cached } = boot({ shellFetch: () => res(true, {}) });   // no x-app-shell header anywhere
    await fire(listeners, "install", {});
    check(!cached.includes("/"), "install refuses to cache a signed-out / as the app shell");
    check(cached.includes("/app.js"), "while still caching the assets that are fine");
  }
  { // a worker whose shell cannot answer a launch must NOT take over from one whose shell can
    const res = (ok, hdr = {}) => ({ ok, status: ok ? 200 : 404, headers: { get: (k) => hdr[k.toLowerCase()] ?? null }, clone() { return this; } });
    const warm = boot({ shellFetch: (u) => res(true, u === "/" ? { "x-app-shell": "1" } : {}) });
    await fire(warm.listeners, "install", {});
    check(warm.calls.some((c) => c.skipWaiting), "a warm replacement shell takes over immediately");

    const cold = boot({ shellFetch: (u) => (u === "/" ? res(false) : res(true, {})) });   // the document itself fails to precache
    await fire(cold.listeners, "install", {});
    check(!cold.calls.some((c) => c.skipWaiting), "a replacement whose document did NOT cache does not take over — the old worker keeps serving its warm shell");
  }
  { // navigation preload was reverted: this app precaches the shell, so a preload would be wasted on every launch
    const { listeners, calls } = boot();
    await fire(listeners, "activate", {});
    check(!calls.some((c) => c.preloadEnabled), "activate does NOT enable navigation preload (Chrome: a precached app shell does not need it)");
    check(calls.some((c) => c.claimed), "regression: activate still claims open clients");
  }
  { // a deliberate "Disable here" must reach the one re-subscription path that lives in the worker
    const { listeners, calls } = boot({ metaPushOff: 1 });
    await fire(listeners, "pushsubscriptionchange", { oldSubscription: null, newSubscription: null });
    check(!calls.some((c) => c.subscribe), "with notifications switched off by hand, pushsubscriptionchange does NOT re-subscribe");
    check(!calls.some((c) => c.method === "POST" && c.url === "/api/push/subscribe"), "and registers nothing");
  }
  { // a prefetch that fails must never cost the notification
    const { listeners, calls, wrote } = boot({ threadRaw: null, tokenOk: false });
    let threw = null;
    try { await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "18f", title: "Alice" }) } }); } catch (e) { threw = e; }
    check(!threw, `a failed prefetch is survived, not thrown — ${threw && threw.message}`);
    check(calls.some((c) => c.show === "Alice"), "and the notification was still raised");
    check(!wrote.some((r) => String(r.k).startsWith("pf:")), "and nothing half-fetched is stashed");
  }

  // ---- The push census. The hub saw two pushes accepted and the phone never fetched afterwards; each push now
  //  leaves a line saying how late it arrived, which windows the worker saw, and what the background download did. ----
  {
    const RAW = { id: "18f", messages: [{ id: "m1", internalDate: "1", payload: {} }] };
    const sentAt = new Date(Date.now() - 4000).toISOString();
    const census = async (opts, payload) => { const b = boot(opts); await fire(b.listeners, "push", { data: { json: () => payload } }); const rows = b.wrote.filter((r) => r.k === "pushlog"); return rows.length ? rows[rows.length - 1].v : null; };
    const hidden = await census({ threadRaw: RAW, windows: [{ postMessage() {}, visibilityState: "hidden" }] }, { kind: "gmail", account: "a@gmail.com", thread: "18f", title: "A", at: sentAt });
    const e1 = hidden && hidden[hidden.length - 1];
    check(!!e1 && e1.pf === "stashed" && e1.windows === 1 && e1.visible === 0, `census: a backgrounded window's push records the download as stashed — ${JSON.stringify(e1)}`);
    check(!!e1 && e1.sentAt && e1.at - e1.sentAt >= 3000, "census: and how late the push arrived, from the hub's own send time");
    const vis = await census({ threadRaw: RAW, windows: [{ postMessage() {}, visibilityState: "visible", focused: true }] }, { kind: "gmail", account: "a@gmail.com", thread: "18f", title: "A", at: sentAt });
    const e2 = vis && vis[vis.length - 1];
    check(!!e2 && /^skip: a window is visible/.test(e2.pf) && e2.visible === 1 && e2.focused === 1, `census: a visible window is recorded as the reason no download ran — ${JSON.stringify(e2)}`);
    const bad = await census({ threadRaw: null, tokenOk: false }, { kind: "gmail", account: "a@gmail.com", thread: "18f", title: "A" });
    const e3 = bad && bad[bad.length - 1];
    check(!!e3 && /^token http/.test(e3.pf), `census: a failed download names the step that failed — ${JSON.stringify(e3)}`);
  }

  // ---- A dismissal that arrives with no new mail behind it ----
  { // the case in the complaint: mail trashed on the Mac, nothing else happening, one notification on the phone
    const shade = [];
    const { listeners } = boot({ shade });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "Jordan Lee", body: "Quarterly update" }) } });
    check(shade.length === 1 && shade[0].tag === "t-a@gmail.com|t1", `the notification is on screen — ${shade.map((n) => n.tag)}`);
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: Date.now() + 5000 }] }) } });
    check(!shade.some((n) => n.tag === "t-a@gmail.com|t1"), "a dismiss push closes it with no new mail involved");
    check(shade.length === 1 && shade[0].tag === "s-zero", `and the shade is NOT left empty — ${shade.map((n) => n.tag)}`);
    check(shade[0].silent === true, "the placeholder is silent, so clearing a notification can never buzz the phone");
  }
  { // CONTROL: the same run against a worker with that ONE line removed. If this does not end with an empty shade, the check
    // above proves nothing: an empty shade at the end of a push handler is exactly what makes Chromium spend push budget.
    const shade = [];
    const strip = (src) => { const out = src.replace("await ensureVisible(clients);", ""); if (out === src) throw new Error("control could not un-apply the fix"); return out; };
    const { listeners } = boot({ shade, patch: strip });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "Jordan Lee" }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: Date.now() + 5000 }] }) } });
    check(shade.length === 0, `CONTROL: without ensureVisible the handler returns with NOTHING on screen — ${shade.map((n) => n.tag)}`);
  }
  { // A dismissal must never close a notification RAISED AFTER IT
    const shade = [];
    const { listeners } = boot({ shade });
    const handledAt = Date.now();
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "a reply arriving after the trash", at: new Date(handledAt + 30_000).toISOString() }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: handledAt }] }) } });
    check(shade.some((n) => n.tag === "t-a@gmail.com|t1"), `the newer notification SURVIVES a stale dismissal — ${shade.map((n) => n.tag)}`);
    check(!shade.some((n) => n.tag === "s-zero"), "and no placeholder is raised, because the shade was never empty");
  }
  { // the same dismissal against a notification raised BEFORE it: this one must go
    const shade = [];
    const { listeners } = boot({ shade });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "older", at: new Date(Date.now() - 60_000).toISOString() }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: Date.now() }] }) } });
    check(!shade.some((n) => n.tag === "t-a@gmail.com|t1"), "a notification older than the dismissal is closed");
  }
  { // one of several: the placeholder must NOT appear, because something real is still up
    const shade = [];
    const { listeners } = boot({ shade });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "one" }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t2", title: "two" }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: Date.now() + 5000 }] }) } });
    check(shade.length === 1 && shade[0].tag === "t-a@gmail.com|t2", `only the handled one goes — ${shade.map((n) => n.tag)}`);
    check(!shade.some((n) => n.tag === "s-zero"), "no placeholder while a real notification is on screen");
  }
  { // the placeholder never outlives a real notification: new mail arriving must sweep it
    const shade = [];
    const { listeners } = boot({ shade });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "one" }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: Date.now() + 5000 }] }) } });
    check(shade.length === 1 && shade[0].tag === "s-zero", "placeholder is up");
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t9", title: "new mail" }) } });
    check(shade.length === 1 && shade[0].tag === "t-a@gmail.com|t9", `and the placeholder is gone the moment real mail lands — ${shade.map((n) => n.tag)}`);
  }
  { // the Worker deployed before this change sent BARE KEYS; a phone that has not reloaded its worker must still be understood
    const shade = [];
    const { listeners } = boot({ shade });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "one" }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t2", title: "two", dismiss: ["a@gmail.com|t1"] }) } });
    check(!shade.some((n) => n.tag === "t-a@gmail.com|t1"), "a bare-string dismissal still closes its notification");
  }
  { // the Done button tells the hub WHICH device acted, so the hub can leave it out of the dismissal it sends
    const { listeners, calls } = boot({ shade: [] });
    await fire(listeners, "notificationclick", { action: "done", notification: { close() {}, data: { account: "a@gmail.com", thread: "t1", url: "/" } } });
    const act = calls.find((c) => String(c.url).includes("/api/notify/act"));
    check(!!act && "endpoint" in (act.body || {}), `the act request carries this device's endpoint — ${act && JSON.stringify(act.body)}`);
  }
  { // with the app open and focused in front of the user, the browser does not require a notification at all, so no placeholder
    const shade = [];
    const { listeners } = boot({ shade, windows: [{ focused: true, visibilityState: "visible", postMessage() {} }] });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "one" }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: Date.now() + 5000 }] }) } });
    check(shade.length === 0, `app open and focused: the shade is simply emptied, no placeholder — ${shade.map((n) => n.tag)}`);
  }
  { // a backgrounded or merely open-but-unfocused window is NOT the exemption, so the placeholder still stands in
    const shade = [];
    const { listeners } = boot({ shade, windows: [{ focused: false, visibilityState: "hidden", postMessage() {} }] });
    await fire(listeners, "push", { data: { json: () => ({ kind: "gmail", account: "a@gmail.com", thread: "t1", title: "one" }) } });
    await fire(listeners, "push", { data: { json: () => ({ kind: "dismiss", dismiss: [{ k: "a@gmail.com|t1", at: Date.now() + 5000 }] }) } });
    check(shade.length === 1 && shade[0].tag === "s-zero", `phone in a pocket: the placeholder stands in — ${shade.map((n) => n.tag)}`);
  }
  console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall push checks passed");
  process.exit(fails.length ? 1 : 0);
})();
