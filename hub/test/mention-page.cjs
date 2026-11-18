// The page half: Settings > Rules lists the "delete unless it mentions" rules with what each has done and the latest
// decisions, adds one only after a warning that names the sender and the words, and removes one. Boots app.js in jsdom with the shared
// fake network and clicks the real buttons and the real confirm dialog.
// Usage: node test/mention-page.cjs (exit 1 on any failed check)
// CONTROL: APP_JS_SRC=<an app.js from before the fix> node test/mention-page.cjs must fail.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const HUB = new URL("../src/client/", "file://" + __dirname + "/").pathname;
const html = fs.readFileSync(HUB + "app.html", "utf8").replace('<script src="/app.js?v=__VERSION__"></script>', "");
const js = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"].map((f) => fs.readFileSync(f === "app.js" && process.env.APP_JS_SRC ? process.env.APP_JS_SRC : HUB + f, "utf8")).join("\n").replace("__VERSION__", "test");
const fails = []; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCT = "sam.owner.sxsw@gmail.com", RID = "0f3c2a54-8d0e-4c1b-9d55-2b7c1e6f9a01";

(async () => {
  const errors = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.detail?.stack || e.message)));
  const dom = new JSDOM(html, { url: "https://mail.yourdomain.example/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window; const { TextEncoder, TextDecoder } = require("util"); w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.eval(fs.readFileSync(__dirname + "/mock-fetch.js", "utf8"));
  const R = w.__mock.routes;
  R["GET /api/gmail/accounts"] = { accounts: [{ email: ACCT, status: "active", label: "SXSW", color: "#aa3366" }], configured: true };
  R["GET /api/bootstrap"].gmail = R["GET /api/gmail/accounts"];
  R["GET /api/mention-rules"] = { rules: [{ id: RID, pattern: "*@uber.com", scope: ACCT, words: ["SXSW", "South by Southwest"], kept: 2, dropped: 31, last_at: "2026-10-16T19:00:00.000Z" }],
    recent: [{ account: ACCT, decision: "dropped", from_addr: "noreply@uber.com", subject: "Your Thursday trip", at: "2026-10-16T19:00:00.000Z" }, { account: ACCT, decision: "rescued", from_addr: "promo@stubhub.com", subject: "Austin in March", at: "2026-10-16T18:00:00.000Z" }] };
  R["GET /api/quiet-rules"] = { rules: [] };
  R["DELETE /api/mention-rules/" + RID] = { ok: true, removed: 1 };
  const posted = [];
  Object.defineProperty(w.navigator, "serviceWorker", { value: undefined, configurable: true });
  w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(js);
  await wait(2500);
  const mocked = w.fetch;
  w.fetch = (url, o = {}) => { if (/\/api\/mention-rules$/.test(String(url)) && o.method === "POST") { const b = JSON.parse(o.body); posted.push(b); return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, rule: { id: "1a2b3c4d-0000-4000-8000-000000000001", pattern: b.pattern, scope: b.scope, words: b.words, kept: 0, dropped: 0 } }), headers: new Map() }); } return mocked(url, o); };
  await w.mh.openSettings("rules"); await wait(300);
  const d = w.document, sec = d.querySelector('[data-sec="rules"]');
  const txt = sec ? sec.textContent.replace(/\s+/g, " ") : "";
  check(/Delete unless it mentions/.test(txt), "Settings > Rules has a \"Delete unless it mentions\" group");
  check(/\*@uber\.com · “SXSW”, “South by Southwest”/.test(txt) && /kept 2, deleted 31, the last 2026-10-16/.test(txt), `a rule shows its sender, words, account and what it has done (${(txt.match(/\*@uber\.com[^R]{0,160}/) || [""])[0]})`);
  check(/deleted · noreply@uber\.com · Your Thursday trip/.test(txt) && /moved out of spam · promo@stubhub\.com/.test(txt), "the latest decisions are listed");
  d.querySelector("#mpat").value = "*@newsco.com"; d.querySelector("#mwords").value = "SXSW,  South by Southwest , "; d.querySelector("#mscope").value = ACCT;
  d.querySelector("#madd").click(); await wait(50);
  const askText = (d.querySelector("#ask .msg") || {}).textContent || "";
  check(/Delete new mail from \*@newsco\.com in sam\.owner\.sxsw@gmail\.com unless it mentions “SXSW” or “South by Southwest”\?/.test(askText), `adding one first asks, naming the sender, the account and the words (${askText})`);
  check(!posted.length, "nothing is saved before the answer");
  d.querySelector("#ask button.danger").click(); await wait(400);
  check(posted.length === 1 && JSON.stringify(posted[0]) === JSON.stringify({ pattern: "*@newsco.com", words: ["SXSW", "South by Southwest"], scope: ACCT }), `then it is saved with clean words (${JSON.stringify(posted[0])})`);
  const before = w.__mock.calls.filter((c) => c === "DELETE /api/mention-rules/" + RID).length;
  const del = d.querySelector(`[data-mdel="${RID}"]`); del && del.click(); await wait(300);
  check(!!del && w.__mock.calls.filter((c) => c === "DELETE /api/mention-rules/" + RID).length === before + 1, "a rule's remove button deletes it");
  check(!errors.length, `no page errors (${errors.join(" | ").slice(0, 300)})`);
  console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nall mention-rule page checks passed");
  process.exit(fails.length ? 1 : 0);
})();
