// The page half: signing out names this device to the hub so it leaves the notification list, and inside the Android
// app tells the app to forget its copy of the session, its stash and its notifications. Boots app.js in jsdom three times (a browser,
// the Android app, the Android app with "Sign out everywhere"), clicks the real Settings buttons and the real confirm dialog, and reads
// what reached the network and the fake bridge.
// Usage: node test/signout-page.cjs (exit 1 on any failed check)
// CONTROL: APP_JS_SRC=<an app.js from before the fix> node test/signout-page.cjs must fail.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const HUB = new URL("../src/client/", "file://" + __dirname + "/").pathname;
const html = fs.readFileSync(HUB + "app.html", "utf8").replace('<script src="/app.js?v=__VERSION__"></script>', "");
const files = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"];
const js = files.map((f) => fs.readFileSync(f === "app.js" && process.env.APP_JS_SRC ? process.env.APP_JS_SRC : HUB + f, "utf8")).join("\n").replace("__VERSION__", "test");
const fails = []; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DEVICE = "fcm:0123456789abcdef", EP = "https://fcm.googleapis.com/fcm/send/browser-endpoint-1";

async function boot({ android }) {
  const errors = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", (e) => { const m = e.detail?.stack || e.message || ""; if (!/Not implemented: navigation/.test(m)) errors.push("jsdomError: " + m); });
  const dom = new JSDOM(html, { url: "https://mail.yourdomain.example/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window; const { TextEncoder, TextDecoder } = require("util"); w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.eval(fs.readFileSync(__dirname + "/mock-fetch.js", "utf8"));
  w.__mock.routes["POST /logout"] = { ok: true };
  const ua = "Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36" + (android ? " SheritAndroid/1.9" : "");
  Object.defineProperty(w.navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(w.navigator, "serviceWorker", { value: undefined, configurable: true });
  w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const seq = [];   // the network's /logout and the bridge's signedOut, in the order they happened
  if (android) w.SheritAndroid = { onmessage: null, postMessage(s) { const m = JSON.parse(s); let result = null;
    if (m.op === "pushDevice") result = DEVICE;
    if (m.op === "signedOut") { seq.push({ bridge: "signedOut" }); result = true; }
    if (m.op === "takeStashes" || m.op === "activeKeys") result = [];
    if (m.op === "log" || m.op === "ackStashes" || m.op === "dismiss") result = true;
    setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ id: m.id, result }) }), 0); } };
  w.eval(js);
  await wait(2500);
  const mocked = w.fetch;
  w.fetch = (url, o = {}) => { if (/\/logout$/.test(String(url))) seq.push({ logout: o.body ? JSON.parse(o.body) : null }); return mocked(url, o); };
  return { w, seq, errors };
}
async function clickSignOut(w, button) {
  await w.mh.openSettings(); await wait(300);
  const b = w.document.querySelector(button); if (!b) return false;
  b.click(); await wait(50);
  const ok = w.document.querySelector("#ask button.danger"); if (!ok) return false;
  ok.click(); await wait(400);
  return true;
}

(async () => {
  {
    const { w, seq, errors } = await boot({ android: false });
    w.mh.noteEndpoint({ endpoint: EP });
    check(await clickSignOut(w, "#signout"), "a browser: Settings > Sign out and its confirm are clicked");
    const out = seq.find((x) => x.logout !== undefined)?.logout;
    check(out && out.endpoint === EP && !out.device && !out.everywhere, `a browser names its Web Push endpoint to /logout, so the hub drops it (${JSON.stringify(out)})`);
    check(!errors.length, `no page errors (${errors.join(" | ").slice(0, 300)})`);
  }
  {
    const { w, seq, errors } = await boot({ android: true });
    w.mh.noteEndpoint({ endpoint: EP });   // never the case in the app (no Web Push), and ignored if it were: the app is named by its push id
    check(await clickSignOut(w, "#signout"), "the Android app: Settings > Sign out and its confirm are clicked");
    const i = seq.findIndex((x) => x.logout !== undefined), j = seq.findIndex((x) => x.bridge === "signedOut"), out = seq[i]?.logout;
    check(out && out.device === DEVICE && !out.endpoint && !out.everywhere, `the Android app names its push id to /logout (${JSON.stringify(out)})`);
    check(i >= 0 && j > i, `and then tells the app it signed out (${JSON.stringify(seq)})`);
    check(!errors.length, `no page errors (${errors.join(" | ").slice(0, 300)})`);
  }
  {
    const { w, seq, errors } = await boot({ android: true });
    check(await clickSignOut(w, "#signoutall"), "the Android app: Settings > Sign out everywhere and its confirm are clicked");
    const i = seq.findIndex((x) => x.logout !== undefined), j = seq.findIndex((x) => x.bridge === "signedOut"), out = seq[i]?.logout;
    check(out && out.everywhere === true && !out.device, `"everywhere" asks the hub to drop every device, naming none (${JSON.stringify(out)})`);
    check(i >= 0 && j > i, `and the app is told it signed out (${JSON.stringify(seq)})`);
    check(!errors.length, `no page errors (${errors.join(" | ").slice(0, 300)})`);
  }
  console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall sign-out page checks passed");
  process.exit(fails.length ? 1 : 0);
})();
