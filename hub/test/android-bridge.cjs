// The web client inside the native Android app: boots app.js in jsdom with a fake `SheritAndroid` bridge (what
// WebViewCompat.addWebMessageListener injects) and checks every place the page hands work to the app.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const HUB = new URL("../src/client/", "file://" + __dirname + "/").pathname;
const html = fs.readFileSync(HUB + "app.html", "utf8").replace('<script src="/app.js?v=__VERSION__"></script>', "");
const js = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"].map((f) => fs.readFileSync(HUB + f, "utf8")).join("\n").replace("__VERSION__", "test");
const fails = []; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const vc = new VirtualConsole(); vc.on("jsdomError", (e) => fails.push("jsdomError: " + (e.detail?.stack || e.message)));
const dom = new JSDOM(html, { url: "https://mail.yourdomain.example/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window; const { TextEncoder, TextDecoder } = require("util"); w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
w.eval(fs.readFileSync(__dirname + "/mock-fetch.js", "utf8"));
Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36 SheritAndroid/1.0", configurable: true });
Object.defineProperty(w.navigator, "serviceWorker", { value: undefined, configurable: true });
w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
const { indexedDB, IDBKeyRange } = require("fake-indexeddb"); w.indexedDB = indexedDB; w.IDBKeyRange = IDBKeyRange;
w.HTMLElement.prototype.scrollIntoView = () => {};
// ---- the fake app ----
const acct = "sam.owner.sxsw@gmail.com", hdr = (name, value) => ({ name, value });
const nativeCalls = []; let stashes = [{ kind: "gmail", account: acct, id: "native-1", at: Date.now(), raw: { id: "native-1", messages: [{ id: "nm1", threadId: "native-1", labelIds: ["INBOX", "UNREAD"], snippet: "fetched by FCM", internalDate: String(Date.now()), payload: { headers: [hdr("From", "Nia <nia@example.com>"), hdr("To", acct), hdr("Subject", "Downloaded while the phone slept"), hdr("Message-ID", "<n1@example.com>")] } }] } }];
let shade = [`${acct}|g1`, `${acct}|native-1`];
w.SheritAndroid = { onmessage: null, postMessage(s) { const m = JSON.parse(s); nativeCalls.push(m); let result = null;
  if (m.op === "takeStashes") result = stashes.map((x) => ({ ...x, file: `f${x.id}.json`, mtime: (x.mtime ??= 1000 + stashes.indexOf(x)) }));   // the app keeps them until acked
  if (m.op === "ackStashes") { stashes = stashes.filter((x) => !m.args.files.some((f) => f.file === `f${x.id}.json` && f.mtime === x.mtime)); result = true; }   // Stash.ack: name AND mtime must match
  if (m.op === "log" || m.op === "restart") result = true;
  if (m.op === "activeKeys") result = shade;
  if (m.op === "dismiss") { shade = shade.filter((k) => !m.args.keys.includes(k)); result = true; }
  if (m.op === "openExternal" || m.op === "saveFile") result = true;
  setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ id: m.id, result }) }), 0); } };
(async () => {
  w.eval(js);
  await new Promise((r) => setTimeout(r, 2500));
  const key = `${acct}|native-1`;
  check(nativeCalls.some((m) => m.op === "takeStashes"), "at boot the page asks the app for the conversations FCM downloaded");
  check(w.mh.state.threads.has(key) && w.mh.state.threads.get(key).subject === "Downloaded while the phone slept", "and the downloaded conversation is in the list from local bytes");
  check(!w.__mock.calls.some((c) => /\/api\/push\/subscribe/.test(c)), "inside the app the page never registers a Web Push subscription of its own");
  check(!stashes.some((x) => x.id === "native-1") && nativeCalls.some((m) => m.op === "ackStashes" && m.args.files.some((f) => f.file === "fnative-1.json" && f.mtime === 1000)), "the app's copy is deleted only by an acknowledgement naming its file and mtime, sent once it is in IndexedDB");
  w.mh.openExternal("https://example.com/a");
  await new Promise((r) => setTimeout(r, 10));
  check(nativeCalls.some((m) => m.op === "openExternal" && m.args.url === "https://example.com/a"), "links out of the app are handed to the app to open");
  // g1 is handled locally (archived) while its notification is still up: the sweep closes it through the app
  const g1 = w.mh.state.threads.get(`${acct}|g1`); if (g1) { g1.state = "archived"; }
  await w.mh.sweepNotifications(); await new Promise((r) => setTimeout(r, 20));
  check(!shade.includes(`${acct}|g1`) && shade.includes(key), `a handled conversation's notification is closed through the app, an unread one is left (${JSON.stringify(shade)})`);
  await w.mh.dismissNotifications([key]); await new Promise((r) => setTimeout(r, 20));
  check(!shade.includes(key), "dismissing a conversation closes its notification in the app");
  // a push downloaded while the app was alive in the background: importNow() takes it and makes it ready before the tap
  stashes = [{ kind: "gmail", account: acct, id: "native-2", at: Date.now(), raw: { id: "native-2", messages: [{ id: "nm2", threadId: "native-2", labelIds: ["INBOX", "UNREAD"], snippet: "x", internalDate: String(Date.now()), payload: { mimeType: "text/plain", headers: [hdr("From", "Ola <ola@example.com>"), hdr("Subject", "Primed in the background")], body: { data: Buffer.from("hi").toString("base64url") } } }] } }];
  const primed = await w.mh.importNow();
  check(primed === 1 && w.mh.state.threads.has(`${acct}|native-2`) && w.mh.prerendered.has(`${acct}|native-2`), `importNow adopts and prerenders what FCM downloaded (${primed})`);
  // a send the deadline cut off is not retried: its outcome is unknown and a retry could send it twice
  const realFetch = w.fetch; let sendCalls = 0;
  w.fetch = (url, o) => { if (/\/api\/send$/.test(String(url))) { sendCalls++; return Promise.reject(new w.DOMException("The operation timed out.", "TimeoutError")); } return realFetch(url, o); };
  const row = await w.mh.queueSend({ gmail: null, draft: { from: "sam@yourdomain.example", from_name: "", to: ["x@example.com"], cc: [], subject: "deadline", text: "t", attachments: [] } });
  row.notBefore = 0; await w.mh.queue.update(row); w.mh.queue.kick(0); await new Promise((r) => setTimeout(r, 2600));   // skip the 5 s undo window (durably: drain reloads rows from IndexedDB), then wait out the first retry back-off (2 s)
  check(sendCalls === 1 && !w.mh.queue.pending().some((r) => r.op === "send"), `a send cut off by its deadline goes out once and is not retried (${sendCalls} attempt(s))`);
  check(/Not confirmed/.test(w.document.querySelector("#toast").textContent) && w.document.querySelector("#cmodal").classList.contains("on"), "the user is told it is not confirmed and gets the draft back");
  w.fetch = realFetch; w.document.querySelector("#cmodal").classList.remove("on");
  // ---- the user's phone: IndexedDB stops answering. Nothing may wait on it for ever. ----
  const idb = w.mh.idb; idb.STALL_MS = 1500;
  // a queue row that is durable BEFORE the stall (a send waiting in its undo window, say)
  await idb.putAllStrict("queue", [{ key: "tomb-1", op: "noop", threadKey: "tomb", status: "pending", attempts: 0, createdAt: Date.now(), notBefore: Date.now() + 3600e3 }]);
  idb.db.transaction = () => ({ abort() {}, objectStore: () => new Proxy({}, { get: () => () => ({}) }) });   // requests that never complete, never error
  const t0 = Date.now(); await w.mh.refresh({ silent: true });
  check(idb.stalled && !w.mh.state.loading && Date.now() - t0 < 6000, `a refresh whose store stops answering still finishes (${Date.now() - t0} ms, stalled: ${JSON.stringify(idb.stalled)})`);
  check(nativeCalls.some((m) => m.op === "log" && /IndexedDB stalled/.test(m.args.m)), "and the stall is written to the phone's log");
  const before = w.__mock.calls.length; await w.mh.refresh({ silent: true });
  check(w.__mock.calls.slice(before).some((c) => /\/api\/threads/.test(c)), "the next refresh reaches the network instead of being skipped");
  // a notification tapped after the stall: its conversation was downloaded by FCM and must open from those bytes
  stashes = [{ kind: "gmail", account: acct, id: "native-3", at: Date.now(), raw: { id: "native-3", messages: [{ id: "nm3", threadId: "native-3", labelIds: ["INBOX", "UNREAD"], snippet: "y", internalDate: String(Date.now()), payload: { mimeType: "text/plain", headers: [hdr("From", "Pia <pia@example.com>"), hdr("Subject", "Tapped after the stall")], body: { data: Buffer.from("still opens").toString("base64url") } } }] } }];
  const k3 = `${acct}|native-3`; const acks = nativeCalls.filter((m) => m.op === "ackStashes").length;
  await w.mh.openUrl(`/?account=${encodeURIComponent(acct)}&thread=native-3`); await new Promise((r) => setTimeout(r, 50));
  check(w.mh.state.cur === k3 && /still opens/.test(w.document.querySelector("#msgs").innerHTML), "a notification tap opens its conversation with the store stalled");
  check(nativeCalls.filter((m) => m.op === "ackStashes").length === acks && stashes.some((x) => x.id === "native-3"), "and that stash stays in the app, because the page could not store it");
  check(!nativeCalls.some((m) => m.op === "restart"), "no restart while the app is in front of the user");
  Object.defineProperty(w.document, "hidden", { value: true, configurable: true }); w.document.dispatchEvent(new w.Event("visibilitychange")); await new Promise((r) => setTimeout(r, 20));
  check(nativeCalls.some((m) => m.op === "restart"), "once the app is out of sight it asks to be restarted, for a working store");
  // removed while the store cannot delete: remembered outside IndexedDB, and deleted for real once a working store is back
  await w.mh.queue.remove("tomb-1");
  check(JSON.parse(w.localStorage.getItem("mh:qgone") || "[]").includes("tomb-1"), "a queue row removed while the store is stalled is remembered outside IndexedDB");
  idb.stalled = null; await idb.open();   // what the restart gives the next page: a working connection to the same database
  check((await idb.getAll("queue")).some((r) => r.key === "tomb-1"), "(the row is still on disk, as it would be after the restart)");
  await w.mh.queue.load();
  check(!(await idb.getAll("queue")).some((r) => r.key === "tomb-1") && !w.mh.queue.mem.has("tomb-1") && !w.localStorage.getItem("mh:qgone"), "so it is deleted on the next load instead of coming back and going out again");
  // An attachment in the app is saved by the app, under its own name. The chip used to be a target=_blank link: in this
  // app that leaves for Chrome, which has no session with the hub, and on the Mac it saved the file as the attachment id.
  {
    const key = `${acct}|gatt`; const pdf = "%PDF-1.4 acmeco %%EOF";
    w.__mock.routes["GET gmail:threads/gatt?"] = { id: "gatt", messages: [{ id: "ma1", threadId: "gatt", labelIds: ["INBOX"], internalDate: String(Date.now()), snippet: "q3",
      payload: { mimeType: "multipart/mixed", headers: [hdr("From", "Angelclub Updates <updates@angelclub.example>"), hdr("To", acct), hdr("Subject", "Quarterly Update for Acmeco")],
        parts: [{ mimeType: "text/plain", body: { size: 2, data: Buffer.from("hi").toString("base64url") } }, { mimeType: "application/pdf", filename: "02 - Oct - Acmeco Q3 2026 Update.pdf", headers: [hdr("Content-Disposition", 'attachment; filename="02 - Oct - Acmeco Q3 2026 Update.pdf"')], body: { size: pdf.length, attachmentId: "att1" } }] } }] };
    w.__mock.routes["GET gmail:messages/ma1/attachments/att1"] = { size: pdf.length, data: Buffer.from(pdf).toString("base64url") };
    w.mh.state.threads.set(key, { key, account: acct, kind: "gmail", id: "gatt", subject: "Quarterly Update for Acmeco", fromAddr: "updates@angelclub.example", fromName: "Angelclub Updates", state: "inbox", unread: false, count: 1, date: Date.now(), unsubKnown: true });
    await w.mh.openThread(key); await new Promise((r) => setTimeout(r, 150));
    // The chip is a preview button plus its own Download button; Download is what saves.
    const chip = w.document.querySelector("#msgs .atts .attdl");
    check(!!chip && !w.document.querySelector("#msgs .atts a[href]"), "in the app, an attachment chip is a button, not a link out to Chrome");
    const n0 = nativeCalls.length; chip && chip.click(); await new Promise((r) => setTimeout(r, 150));
    const save = nativeCalls.slice(n0).find((m) => m.op === "saveFile");
    check(save && save.args.name === "02 - Oct - Acmeco Q3 2026 Update.pdf" && save.args.mime === "application/pdf" && Buffer.from(save.args.b64, "base64").toString() === pdf, `tapping it saves the file under its own name, with its bytes (${JSON.stringify(save && { name: save.args.name, mime: save.args.mime })})`);
  }
  console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall android bridge checks passed");
  process.exit(fails.length ? 1 : 0);
})();
