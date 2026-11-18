/* perf.js: Superhuman-style interaction latency instrumentation.
   Every user-initiated interaction is timed from the input event's timeStamp to the next animation frame after the DOM
   updated. Buckets: <50 ms (fast), <100 ms (ok), <1000 ms (slow), terrible. Samples taken while the tab is hidden are
   dropped. Network calls per refresh are counted. Numbers live in memory + IndexedDB meta and show in Settings → Speed. */
const perf = (() => {
  const buckets = ["fast", "ok", "slow", "terrible"];
  const stats = {};                    // name -> { n, fast, ok, slow, terrible, samples: [] (last 200) }
  let lastInput = 0;                   // timeStamp of the most recent user input (capture phase)
  const net = { calls: 0, lists: 0, gets: 0, history: 0, bytes: 0, byKind: {} };
  const boot = { t0: performance.timeOrigin ? 0 : 0, firstPaint: null, storeReady: null, networkDone: null, cached: null };
  for (const ev of ["pointerdown", "keydown", "touchstart", "click"]) addEventListener(ev, (e) => { if (e.isTrusted) lastInput = e.timeStamp; }, { capture: true, passive: true });
  function record(name, ms) {
    if (document.hidden) return;
    const s = stats[name] ||= { n: 0, fast: 0, ok: 0, slow: 0, terrible: 0, samples: [] };
    s.n++; s[ms < 50 ? "fast" : ms < 100 ? "ok" : ms < 1000 ? "slow" : "terrible"]++;
    s.samples.push(Math.round(ms)); if (s.samples.length > 200) s.samples.shift();
    dirty();
  }
  function dirty() { if (record.dirty) return; record.dirty = true; setTimeout(() => { record.dirty = false; perf.save(); }, 5000); }
  // Which hub sync each refresh ran, and when it finished (sync.js syncHub). kind: "delta" (the change feed; `deferred: "full:daily"` when
  // the daily pass was due and left for later, `lastFullH` the hours since one completed), "full:deferred" (that pass, ~30 s on, in the
  // background), "full:nocursor" / "full:reset" / "full:once" (a full pass at once: no cursor, the feed forgot it, a one-time refresh),
  // "full:switch" (a delta that also took a newly switched Gmail account's mirror), "full:daily" (the daily pass inline: a direct call).
  // at/doneAt are ms from page load, the clock boot.firstPaint and boot.networkDone use. boot.hubSync is the start's own (the first of
  // the page load), boot.hubFull the background pass. `starts` keeps the last 20 starts, since a report reaches the hub every six hours.
  const syncs = []; let starts = []; const START = new Date(performance.timeOrigin || Date.now()).toISOString();
  function hubSync(e) {
    const now = performance.now(), x = { ...e, at: Math.round(now - e.ms), ms: Math.round(e.ms), doneAt: Math.round(now) };
    syncs.push(x); if (syncs.length > 20) syncs.shift();
    if (!boot.hubSync) boot.hubSync = x;
    if (x.kind === "full:deferred" && !x.error && !boot.hubFull) boot.hubFull = x;
    dirty();
  }
  const thisStart = () => ({ at: START, version: build(), firstPaint: boot.firstPaint, networkDone: boot.networkDone, hubSync: boot.hubSync || null, hubFull: boot.hubFull || null });
  // measure(name, fn): fn does the synchronous DOM work (or returns a promise for the async part). The interaction is timed
  // from the triggering input to the frame after fn's synchronous work; async continuations are timed separately as name+":net".
  function measure(name, fn, inputTs = lastInput) {
    const start = inputTs && performance.now() - inputTs < 5000 ? inputTs : performance.now();
    let result;
    try { result = fn(); } finally {
      requestAnimationFrame(() => record(name, performance.now() - start));
    }
    if (result && typeof result.then === "function") { const t1 = performance.now(); result.then(() => requestAnimationFrame(() => record(name + ":net", performance.now() - t1))).catch(() => {}); }
    return result;
  }
  function pct(s, k) { return s.n ? Math.round((100 * s[k]) / s.n) : 0; }
  function quantile(arr, q) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; }
  function report() {
    const rows = Object.entries(stats).map(([name, s]) => ({ name, n: s.n, under50: pct(s, "fast"), under100: pct(s, "fast") + pct(s, "ok"), under1000: 100 - pct(s, "terrible"), p50: quantile(s.samples, 0.5), p95: quantile(s.samples, 0.95) })).sort((a, b) => b.n - a.n);
    // Everything needed to tell a real phone's boot from a laptop's, because the local harness CANNOT answer it: test/preview.py
    // 404s /sw.js on purpose, so no measurement taken here ever has a service worker controlling the page, and with the shell
    // served cache-first by that worker, first paint should stop tracking RTT entirely. `swControlled` is the field that says
    // whether that is actually true on the device.
    const c = navigator.connection || {};
    return { version: typeof VERSION !== "undefined" ? VERSION : "", ua: navigator.userAgent, at: new Date().toISOString(),
      swControlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      display: (() => { try { return ["standalone", "fullscreen", "minimal-ui"].find((m) => matchMedia(`(display-mode: ${m})`).matches) || "browser"; } catch (_) { return "?"; } })(),
      conn: { type: c.effectiveType || null, downlinkMbps: c.downlink ?? null, rttMs: c.rtt ?? null, saveData: !!c.saveData },
      // workerStart is the whole point of this block: it is when the browser began starting the SERVICE WORKER for this
      // navigation, so (responseStart - workerStart) is what the worker cost and (workerStart) is what was spent before it even
      // began. On 2026-09-18 the document took 775 ms of an 881 ms first paint and nothing here could say which half it was.
      nav: (() => { try { const n = performance.getEntriesByType("navigation")[0]; if (!n) return null;
        const r = (x) => (x == null ? null : Math.round(x));
        return { ttfb: r(n.responseStart), domReady: r(n.domContentLoadedEventEnd), load: r(n.loadEventEnd),
          workerStart: r(n.workerStart), fetchStart: r(n.fetchStart), requestStart: r(n.requestStart), responseEnd: r(n.responseEnd),
          swBootMs: n.workerStart ? r(n.fetchStart - n.workerStart) : null,      // worker startup before the request could even begin
          swAnswerMs: n.workerStart ? r(n.responseStart - n.fetchStart) : null,  // how long the worker took to answer once it was up
          servedByWorker: !!n.workerStart, transferBytes: n.transferSize || 0, type: n.type }; } catch (_) { return null; } })(),
      assets: (() => { try { return performance.getEntriesByType("resource").filter((r) => (r.transferSize || 0) > 2000)
        .map((r) => ({ n: r.name.split("/").pop().split("?")[0], kb: Math.round((r.transferSize || 0) / 1024), ms: Math.round(r.duration), cached: r.transferSize === 0 }))
        .sort((a, b) => b.kb - a.kb).slice(0, 12); } catch (_) { return []; } })(),
      boot, net, rows, hubSyncs: syncs, starts: [...starts, thisStart()] };
  }
  function netCall(kind, bytes = 0) { net.calls++; net.bytes += bytes; net.byKind[kind] = (net.byKind[kind] || 0) + 1; if (/threads\?|messages\?|api\/threads\?/.test(kind)) net.lists++; if (/threads\/|messages\/|api\/threads\//.test(kind)) net.gets++; if (/history/.test(kind)) net.history++; }
  function resetNet() { net.calls = 0; net.lists = 0; net.gets = 0; net.history = 0; net.bytes = 0; net.byKind = {}; }
  // Samples are kept per BUILD: a new version starts from zero, so a report describes the code that is running. Carried across builds,
  // the first field report still showed sort:compare at 1,144 ms from before that fix shipped, next to the fixed render.
  // History is not lost: each day's report is kept by the hub (POST /api/perf, one object per device per day).
  const build = () => { try { return VERSION; } catch (_) { return ""; } };
  // The starts saved before this one are read before the first save, or that save would write over them.
  async function save() { try { await (loaded || load()); if (typeof idb !== "undefined" && idb.meta) await idb.meta("perf", { version: build(), stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v, samples: v.samples.slice(-100) }])), at: Date.now(), starts: [...starts, thisStart()].slice(-20) }); } catch (_) {} }
  let loaded = null;   // load runs once, and only from an open store (idb.req answers undefined before it opens)
  function load() { if (!loaded && (typeof idb === "undefined" || !idb.db)) return Promise.resolve(); return (loaded ||= (async () => { try { const m = typeof idb !== "undefined" && idb.meta ? await idb.meta("perf") : null; if (m?.stats && m.version === build()) for (const [k, v] of Object.entries(m.stats)) if (!stats[k]) stats[k] = v; if (Array.isArray(m?.starts)) starts = m.starts.filter((s) => s && s.at !== START).slice(-19); } catch (_) {} })()); }
  function reset() { for (const k of Object.keys(stats)) delete stats[k]; save(); }
  return { measure, record, report, netCall, resetNet, boot, stats, net, save, load, reset, hubSync, get lastInput() { return lastInput; } };
})();
