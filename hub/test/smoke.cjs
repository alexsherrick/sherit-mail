// jsdom smoke test for the client: boots app.html + app.js with a fake network, exercises render/open/compose paths, reports errors.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const HUB = new URL("../src/client/", "file://" + __dirname + "/").pathname;
const html = fs.readFileSync(HUB + "app.html", "utf8").replace('<script src="/app.js?v=__VERSION__"></script>', "");
const js = ["perf.js","store.js","sync.js","queue.js","search.js","trust.js","app.js"].map((f) => fs.readFileSync(HUB + f, "utf8")).join("\n").replace("__VERSION__", "test");
const errors = [];
const vc = new VirtualConsole(); vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.detail?.stack || e.message))); vc.on("error", (m) => errors.push("console.error: " + m)); vc.on("log", () => {});
const dom = new JSDOM(html, { url: "https://mail.yourdomain.example/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window; const { TextEncoder, TextDecoder } = require("util"); w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
// ---- fake IndexedDB (absent in jsdom): app must tolerate it
// ---- fake fetch (shared with test/preview.py): test/mock-fetch.js installs window.fetch and records calls/unmocked routes
w.eval(fs.readFileSync(__dirname + "/mock-fetch.js", "utf8"));
const calls = w.__mock.calls;
Object.defineProperty(w.navigator, "serviceWorker", { value: undefined, configurable: true });
w.confirm = () => true;
w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
try { const { indexedDB, IDBKeyRange } = require("fake-indexeddb"); w.indexedDB = indexedDB; w.IDBKeyRange = IDBKeyRange; } catch (e) { w.indexedDB = undefined; console.log("no fake-indexeddb:", e.message); }
w.HTMLElement.prototype.scrollIntoView = () => {};
w.addEventListener("error", (e) => errors.push("window error: " + (e.error?.stack || e.message)));
(async () => {
  try { w.eval(js); } catch (e) { errors.push("eval: " + e.stack); }
  await new Promise((r) => setTimeout(r, 2500));
  const doc = w.document;
  const rows = doc.querySelectorAll("#threads .t").length; const nav = doc.querySelectorAll("#nav a").length;
  console.log("rows rendered:", rows, "| nav entries:", nav, "| chips:", doc.querySelectorAll("#chips button").length);
  console.log("nav counts:", [...doc.querySelectorAll("#nav a")].map((a) => a.textContent.trim().replace(/\s+/g, " ")).slice(0, 8).join(" | "));
  // open hub thread
  const first = doc.querySelector('#threads .t[data-key="hub|11111111-1111-1111-1111-111111111111"]'); if (first) first.click(); await new Promise((r) => setTimeout(r, 400));
  console.log("thread view msgs:", doc.querySelectorAll("#msgs .m").length, "| title:", doc.querySelector("#vtitle").textContent, "| actions visible:", doc.querySelector("#actions").style.display);
  // open gmail thread through the Gmail adapter's thread() (format=full route is unmocked → expect graceful error, not crash)
  const g = doc.querySelector('#threads .t[data-key="sam.owner.sxsw@gmail.com|g2"]'); if (g) { g.click(); await new Promise((r) => setTimeout(r, 400)); console.log("gmail thread pane:", doc.querySelector("#msgs").textContent.trim().slice(0, 60)); }
  // categories
  const chips = [...doc.querySelectorAll("#chips button")]; const notif = chips.find((b) => b.dataset.cat === "notifications"); if (notif) { notif.click(); await new Promise((r) => setTimeout(r, 400)); console.log("notifications rows:", doc.querySelectorAll("#threads .t").length); }
  const news = [...doc.querySelectorAll("#chips button")].find((b) => b.dataset.cat === "newsletters"); if (news) { news.click(); await new Promise((r) => setTimeout(r, 400)); console.log("newsletters rows:", doc.querySelectorAll("#threads .t").length); }
  // compose + mime
  doc.querySelector("#composeBtn").click(); console.log("compose open:", doc.querySelector("#cmodal").classList.contains("on"), "from:", doc.querySelector("#cfrom").value);
  const mime = w.eval('buildMime({from:"a@b.c",from_name:"A B",to:["x@y.z"],subject:"Hé llo",text:"body ✓",attachments:[{filename:"f.txt",type:"text/plain",content:"aGk="}]})');
  const raw = Buffer.from(mime.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  console.log("mime ok:", /^From: "A B" <a@b.c>\r\nTo: x@y.z\r\nSubject: =\?UTF-8\?B\?/.test(raw), "| multipart:", raw.includes("multipart/mixed"), "| attachment part:", raw.includes('filename="f.txt"'));
  // settings
  doc.querySelector("#settingsBtn").click(); await new Promise((r) => setTimeout(r, 400)); console.log("settings rendered:", doc.querySelector("#scard").textContent.includes("Sender rules"), "| notify select:", !!doc.querySelector("#notify"), "| signatures:", doc.querySelectorAll("[data-sig]").length);
  doc.querySelector("#settingsBtn") && doc.querySelector("#sclose")?.click(); [...doc.querySelectorAll("#chips button")].find((b) => b.dataset.cat === "inbox")?.click(); await new Promise((r) => setTimeout(r, 400));
  console.log("new-senders block:", doc.querySelector("[data-gk=acceptall]") ? "present (alice pending)" : "ABSENT", "| screened rows:", doc.querySelectorAll("[data-gk=accept]").length, "| More menu:", !!doc.querySelector('[data-act="more"]'));
  const acc = doc.querySelector("[data-gk=accept]"); if (acc) { acc.click(); await new Promise((r) => setTimeout(r, 300)); console.log("after accept, screened rows:", doc.querySelectorAll("[data-gk=accept]").length); }
  console.log("dedupe: hub copy hidden?", (()=>{w.mh.state.hubMsgIds=new Set(["gm3@mail.gmail.com"]); return w.mh.isHubCopy(w.mh.state.threads.get("sam.owner.sxsw@gmail.com|g3"))})(), "| partial thread kept?", (()=>{const t={...w.mh.state.threads.get("sam.owner.sxsw@gmail.com|g3"), msgIds:["gm3@mail.gmail.com","other"]}; return !w.mh.isHubCopy(t)})());
  console.log("categorize:", w.eval('JSON.stringify([categorize({from:"noreply@x.y"}), categorize({headers:{"list-unsubscribe":"x"},from:"a@b.c"}), categorize({from:"bob@x.y"}), categorize({labels:["CATEGORY_UPDATES"],from:"a@b.c"})])'));
  // gate 3: local action is instant and queued; drain persists it
  const g1 = w.mh.state.threads.get("sam.owner.sxsw@gmail.com|g1"); const before = w.mh.queue.pending().length; w.mh.localAct(g1, "archive", { quiet: true }); console.log("prerendered threads:", w.mh.prerendered.size); console.log("queued after archive:", w.mh.queue.pending().length - before, "| local state:", g1.state); await new Promise((r) => setTimeout(r, 600)); console.log("queue after drain:", w.mh.queue.pending().length, "| modify called:", calls.filter((c) => c.includes("threads/g1/modify")).length);
  w.mh.openThread("hub|11111111-1111-1111-1111-111111111111"); w.mh.openPalette(); const pc = doc.querySelectorAll("#plist [data-i]").length; doc.querySelector("#pq").value = "done"; doc.querySelector("#pq").dispatchEvent(new w.Event("input")); console.log("palette commands:", pc, "| filtered for 'done':", doc.querySelectorAll("#plist [data-i]").length, "| first:", doc.querySelector("#plist [data-i] b")?.textContent); doc.querySelector("#tmodal").classList.remove("on");
  console.log("snippet vars:", JSON.stringify(w.mh.fillVars("Hi {{first}}, re {{subject}}", w.mh.state.threads.get("hub|11111111-1111-1111-1111-111111111111"))));
  { const html = w.mh.mdToHtml('[x](javascript:alert(1)) <img src=x onerror=alert(1)> **a"onmouseover="alert(1)** [y](https://ok.io/p?a=1&b="x") https://z.io/<script> [click](https://x.example/" onmouseover="alert(1)" x=")'); const d = new w.DOMParser().parseFromString(html, "text/html"); const els = [...d.querySelectorAll("*")]; const badAttr = els.flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name) || (a.name === "href" && !/^https?:\/\//.test(a.value)))); const badEl = els.filter((e) => /^(script|img|iframe|object|embed|form|style)$/i.test(e.tagName)); console.log("md-xss:", badAttr.length || badEl.length ? "LEAK " + html : "clean (" + els.length + " elements, " + d.querySelectorAll("a").length + " links)"); }
  { const tt = w.mh.state.threads.get("hub|11111111-1111-1111-1111-111111111111"); const keep = tt.fromAddr; tt.fromAddr = '"<img src=x onerror=alert(1)>"@evil.example'; try { w.mh.openMenuFor(tt); const menu = doc.querySelector("#menu"); console.log("menu-xss:", menu.querySelector("img") ? "LEAK" : "clean (" + menu.querySelectorAll("button").length + " items)"); } finally { tt.fromAddr = keep; } }
  { // unread triage: view, select all, ONE bulk done → 1 batchModify per Gmail account + 1 hub bulk request; undo restores; failure path
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    await w.mh.queue.drain(); for (let i = 0; i < 100 && w.mh.state.loading; i++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 200));
    w.mh.setView("unread"); const n0 = w.mh.visibleThreads().length; const c0 = calls.length; w.mh.selectAll(); const sel = w.mh.state.checked.size; check(sel === n0 && n0 >= 2, `select all picked ${sel} of ${n0}`);
    const picked = [...w.mh.state.checked]; await w.mh.bulk("done", picked.map((k) => w.mh.state.threads.get(k))); await w.mh.queue.drain();
    const after = calls.slice(c0); const bm = after.filter((c) => /batchModify/.test(c)).length, tm = after.filter((c) => /threads\/g\d\/modify/.test(c)).length, hb = after.filter((c) => /threads\/bulk/.test(c)).length, singles = after.filter((c) => /PATCH \/api\/threads\//.test(c)).length;
    const left = w.mh.visibleThreads().filter((t) => picked.includes(t.key)).length; const job = w.mh.state.bulkLog[0];
    console.log("unread view rows:", n0, "| selected:", sel, "| picked rows still shown:", left, "| batchModify:", bm, "| threads.modify:", tm, "| hub bulk:", hb, "| single PATCH:", singles, "| job:", job.status, "done", (job.done || []).length);
    check(bm === 0 && tm === 1 && hb === 1 && singles === 0, `bulk went out as ${bm} batch + ${tm} thread + ${hb} hub + ${singles} single calls (expected 0/1/1/0)`); check(left === 0, "done rows left the unread view"); check(job.status === "done" && job.done.length === sel, "job done with every key receipted");
    await w.mh.bulkUndo(job.id); await w.mh.queue.drain(); check(job.status === "undone", "undo status " + job.status); check(picked.every((k) => w.mh.state.threads.get(k).unread === true), "undo restored unread on every thread");
    // failure injection: the hub refuses the bulk (400 → permanent) → job failed, rows reverted locally, nothing marked done
    const hubT = [...w.mh.state.threads.values()].filter((t) => t.kind === "hub" && t.state === "inbox").slice(0, 1); w.__mock.failNext = { match: /POST \/api\/threads\/bulk/, status: 400, body: { error: "injected" } };
    await w.mh.bulk("trash", hubT, { quiet: true }); await w.mh.queue.drain(); const j2 = w.mh.state.bulkLog[0];
    console.log("failure path: job", j2.status, "| thread state:", hubT[0].state, "| failNext consumed:", w.__mock.failNext === null);
    check(j2.status === "failed" && hubT[0].state === "inbox", "failed bulk rolled back locally with status failed");
    w.mh.setView("inbox"); }
  { const p = w.mh.ask("Test question?"); await new Promise((r) => setTimeout(r, 20)); const on = doc.querySelector("#ask").classList.contains("on"); doc.querySelector("#ask button.primary").click(); const v = await p; console.log("ask toast:", on ? "shown" : "NOT shown", "| resolved:", v); if (!on || v !== true) errors.push("ASSERT ask toast"); }
  console.log("md:", w.mh.mdToHtml("# Hi\n\n**bold** and *it* <script>x</script>\n\n- a\n- b\n\n> q\n\nhttps://x.io/p").replace(/\n/g, ""));
  { const raw = Buffer.from(w.mh.buildMime({ from: "a@b.c", to: ["d@e.f"], subject: "s", text: "hi", html: "<p>hi</p>" }).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(); console.log("mime alt:", /multipart\/alternative/.test(raw), "| html part:", /text\/html/.test(raw)); }
  { w.mh.state.rules = [{ pattern: "*@spam.io", action: "block", scope: "*" }, { pattern: "ok@spam.io", action: "accept", scope: "*" }]; console.log("domain rule:", w.mh.senderRule("x@spam.io", "hub")?.action, "| exception:", w.mh.senderRule("ok@spam.io", "hub")?.action); w.mh.state.rules = []; }
  { // the indexed senderRule() answers exactly as the old full scan did: precedence, case, scope, and a rule list that changes under it
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const ref = (rules, addr, account) => { const lc = (x) => String(x || "").trim().toLowerCase(); const a = lc(addr), dom = a.split("@")[1]; let best = null; for (const r of rules) { if (r.scope !== "*" && lc(r.scope) !== lc(account)) continue; const p = lc(r.pattern); const exact = p === a; if (!(exact || (p.startsWith("*@") && p.slice(2) === dom))) continue; if (!best || (r.scope !== "*" && best.scope === "*") || (exact && lc(best.pattern).startsWith("*@") && !(best.scope !== "*" && r.scope === "*"))) best = r; } return best; };
    const R = [{ pattern: "*@shop.io", scope: "*", action: "block" }, { pattern: "deals@shop.io", scope: "*", action: "accept" }, { pattern: "*@shop.io", scope: "a@gmail.com", category: "newsletters" }, { pattern: "Boss@Work.com", scope: "*", action: "priority" }, { pattern: "boss@work.com", scope: "b@gmail.com", action: "block" }, { pattern: "*@work.com", scope: "*", category: "personal" }, { pattern: "*@", scope: "*", action: "block" }, { pattern: "x@shop.io", scope: "a@gmail.com", action: "priority" }];
    const addrs = ["deals@shop.io", "other@shop.io", "x@shop.io", "BOSS@work.com", " boss@work.com ", "eve@work.com", "nobody", "", "weird@", "a@b.c"]; const accts = ["a@gmail.com", "b@gmail.com", "hub", "*"];
    let bad = 0, n = 0; const runAll = () => { for (const a of addrs) for (const ac of accts) { n++; if (w.mh.senderRule(a, ac) !== ref(w.mh.state.rules, a, ac)) bad++; } };
    w.mh.state.rules = R.slice(); runAll(); runAll();                                            // cold, then remembered
    w.mh.state.rules.push({ pattern: "eve@work.com", scope: "*", action: "priority" }); runAll();   // pushed in place
    w.mh.state.rules = w.mh.state.rules.filter((r) => r.pattern !== "deals@shop.io"); runAll();   // replaced by a filter
    console.log("senderRule index:", n, "lookups,", bad, "differ from the full scan"); check(bad === 0 && n === 160, `indexed senderRule matches the full scan (${bad} of ${n} differ)`);
    w.mh.state.rules = [];
  }
  errors.push(...w.__mock.errors.filter((e) => !/batch\/gmail/.test(e)));

  // ---- review fixes ----
  const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
  { // P1: Block and Snooze change the local state (the row leaves the inbox now, not at the next sync); a failed remote trash rolls back
    const byId = (p) => [...w.mh.state.threads.values()].find((t) => t.kind === "hub" && String(t.id).startsWith(p));
    const t4 = byId("4444"), t3 = byId("3333");
    if (t4 && t4.state === "inbox") {
      w.__mock.failNext = { match: /PATCH \/api\/threads\/44444444/, status: 400, body: { error: "injected" } };
      await w.mh.act(t4, "block", { quiet: true }); await new Promise((r) => setTimeout(r, 30));
      console.log("block (remote failed): state", t4.state, "| row present:", !!doc.querySelector(`.t[data-key="${t4.key}"]`));
      check(t4.state === "inbox" && !!doc.querySelector(`.t[data-key="${t4.key}"]`), "block with failed trash rolled the row back");
      await w.mh.act(t4, "block", { quiet: true }); await new Promise((r) => setTimeout(r, 30));
      console.log("block: state", t4.state, "| row present:", !!doc.querySelector(`.t[data-key="${t4.key}"]`));
      check(t4.state === "trash" && !doc.querySelector(`.t[data-key="${t4.key}"]`), "block trashed locally and removed the row");
    } else errors.push("ASSERT block fixture 4444 not in inbox");
    if (t3 && t3.state === "inbox") {
      w.mh.act(t3, "snooze"); await new Promise((r) => setTimeout(r, 20)); const b = doc.querySelector('#tcard button[data-i="0"]'); if (b) b.click(); await new Promise((r) => setTimeout(r, 60));
      console.log("snooze: state", t3.state, "| row present:", !!doc.querySelector(`.t[data-key="${t3.key}"]`), "| modal on:", doc.querySelector("#tmodal").classList.contains("on"));
      check(t3.state === "snoozed" && !doc.querySelector(`.t[data-key="${t3.key}"]`), "snooze set the local state and removed the row");
    } else errors.push("ASSERT snooze fixture 3333 not in inbox");
  }
  { // P2: one owner for #tmodal; a prompt interrupted by the palette resolves as cancelled instead of hanging
    const p = w.mh.askText("Rename", "x"); await new Promise((r) => setTimeout(r, 10)); w.mh.openPalette();
    const v = await Promise.race([p, new Promise((r) => setTimeout(() => r("hung"), 300))]);
    console.log("askText then palette:", v === null ? "cancelled" : v); check(v === null, "interrupted askText resolved null");
    doc.querySelector("#pq")?.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); console.log("palette closed:", !doc.querySelector("#tmodal").classList.contains("on"));
  }
  { // P0: an ambiguous work-mail send (409) is not "Not sent": the draft comes back flagged and the next send asks first
    const draft = { from: "sam@yourdomain.example", to: ["bob@example.com"], subject: "Amb", text: "hello" };
    w.__mock.failNext = { match: /POST \/api\/send/, status: 409, body: { error: "may already have left", code: "ambiguous_send", message_id: "<k@x>" } };
    const row = await w.mh.queueSend({ draft }); row.notBefore = 0; await w.mh.queue.update(row); await w.mh.queue.drain(); await new Promise((r) => setTimeout(r, 30));
    console.log("ambiguous send: maybeSent", JSON.stringify(w.mh.state.maybeSent), "| pending:", w.mh.queue.pending().length, "| toast:", (doc.querySelector("#toast")?.textContent || "").slice(0, 60));
    check(w.mh.state.maybeSent && w.mh.state.maybeSent.messageId === "<k@x>", "ambiguous send flagged maybeSent");
    const p2 = w.mh.queueSend({ draft }); await new Promise((r) => setTimeout(r, 20)); const askOn = doc.querySelector("#ask").classList.contains("on"); doc.querySelector("#ask button.danger").click(); const row2 = await p2;
    console.log("resend asked:", askOn, "| queued:", !!row2, "| maybeSent cleared:", w.mh.state.maybeSent === null);
    check(askOn && row2 && w.mh.state.maybeSent === null, "resend asked and cleared the flag");
    row2.notBefore = 0; await w.mh.queue.update(row2); await w.mh.queue.drain(); console.log("resend drained, pending:", w.mh.queue.pending().length); check(w.mh.queue.pending().length === 0, "resend went through");
  }
  { // P2: strict image sniff (the Worker's classifier, extracted verbatim from src/index.js)
    const src = fs.readFileSync(__dirname + "/../src/index.js", "utf8"); const m = src.match(/const sniffImage = (\(b\) => [\s\S]*?\|\| null);/); const sniff = eval("(" + m[1] + ")");
    const B = (...xs) => { const u = new Uint8Array(16); xs.forEach((x, i) => (u[i] = typeof x === "string" ? x.charCodeAt(0) : x)); return u; }; const S = (s0) => B(...s0.split(""));
    const cases = [["png", B(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png"], ["jpeg", B(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"], ["gif", S("GIF89a"), "image/gif"], ["webp", S("RIFF\x10\x00\x00\x00WEBPVP8 "), "image/webp"], ["wave", S("RIFF\x10\x00\x00\x00WAVEfmt "), null], ["avif", S("\x00\x00\x00\x1cftypavif"), "image/avif"], ["mp4", S("\x00\x00\x00\x1cftypisom"), null], ["ico", B(0, 0, 1, 0, 1, 0), "image/x-icon"], ["html", S("<html><body>"), null], ["short", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), null]];
    const bad = cases.filter(([n, b, want]) => sniff(b) !== want); console.log("sniffImage:", cases.length - bad.length, "/", cases.length, "cases", bad.length ? "FAILED " + bad.map(([n, b]) => n + "=" + sniff(b)).join(",") : "");
    check(!bad.length, "sniffImage cases");
    // HubSpot's CTA images answer 406 to an Accept with no */*; the proxy asks the way browsers do.
    const acc = (src.match(/const IMG_ACCEPT = "([^"]+)"/) || [])[1] || "";   // fetchImageSafely's, named since fonts ask with their own
    check(/(^|,)\*\/\*(;q=[\d.]+)?$/.test(acc), `the image proxy's Accept ends in */*, like a browser's (${acc})`);
  }

  { // search goes deeper: first server page, footer, then the next page by scrolling (searchMore), then "every match listed"
    const q = doc.querySelector("#q"); q.value = "hello"; q.dispatchEvent(new w.Event("input", { bubbles: true }));
    const foot = () => (doc.querySelector("#threads .more")?.textContent || "").trim();
    const f0 = foot(); await new Promise((r) => setTimeout(r, 1000)); const f1 = foot(); const hits1 = w.mh.state.serverHitKeys ? w.mh.state.serverHitKeys.size : -1;
    console.log("search footer:", JSON.stringify(f0), "→", JSON.stringify(f1), "| server hits:", hits1);
    check(f0 === "Searching the servers…" && f1 === "Scroll for older matches" && hits1 === 3, "first server page and footer");
    await w.mh.searchMore(doc.querySelector("#threads .more")); const f2 = foot(); const hits2 = w.mh.state.serverHitKeys.size;
    const g9 = doc.querySelector('.t[data-key="sam.owner.sxsw@gmail.com|g9"]');
    check(f2 === "Every match on the servers is listed" && hits2 === 6 && !!g9, "second page pulled, uncached thread rendered from its newest message, footer closed");

    // A hit the server found but this device never synced was rendered with a "server" badge and then did nothing at all when
    // clicked: every path that acts on a row starts from state.threads, and the row lived only in state.serverSearch.
    const K9 = "sam.owner.sxsw@gmail.com|g9", K10 = "sam.owner.sxsw@gmail.com|g10";
    check(!w.mh.state.threads.has(K9) && w.mh.state.serverSearch.has(K9), "the fixture is a genuine server-only row (not in state.threads)");
    check(/server/.test(g9.textContent), "it carries the server badge");
    g9.click(); await new Promise((r) => setTimeout(r, 500));
    const open9 = { cur: w.mh.state.cur, viewing: doc.querySelector("#app").classList.contains("viewing"), title: doc.querySelector("#vtitle").textContent, msgs: doc.querySelectorAll("#msgs .m").length };
    console.log("server hit opened:", JSON.stringify(open9));
    check(open9.cur === K9 && open9.viewing && open9.title === "Hello from 2023" && open9.msgs >= 1, `clicking a server hit opens it — ${JSON.stringify(open9)}`);
    check(w.mh.state.threads.has(K9) && !w.mh.state.threads.get(K9)._server, "and it is an ordinary thread from then on");
    check(!!(await w.mh.idb.get("threads", K9)), "and it reached the local store");

    // the same row selected rather than opened: the selection bar resolved it through state.threads and dropped it on the floor
    const before = w.mh.queue.pending().length; w.mh.state.checked.add(K10);
    const btn = [...doc.querySelectorAll("#selbar button")].find((b) => b.dataset.bulk === "archive");
    btn.click(); await new Promise((r) => setTimeout(r, 500));
    const t10 = w.mh.state.threads.get(K10);
    console.log("server hit bulk-archived:", t10 && t10.state, "| queued:", w.mh.queue.pending().length - before);
    check(!!t10 && t10.state === "archived", `a selected server hit is acted on, not skipped — ${t10 && t10.state}`);
    await w.mh.queue.drain();

    // the hub branch of the same search sets no _server flag at all, so its unsynced hits render as ordinary-looking rows that
    // also did nothing when clicked. Adoption must not depend on the badge.
    const KH = "hub|55555555-5555-5555-5555-555555555555";
    w.mh.state.serverSearch.set(KH, { key: KH, kind: "hub", account: "hub", id: "55555555-5555-5555-5555-555555555555", subject: "Older hub mail", fromAddr: "someone@example.com", fromName: "Someone", state: "archived", unread: 0, date: Date.now(), labels: [] });
    const adopted = w.mh.threadFor(KH);
    console.log("badge-less server hit adopted:", !!adopted, "| now in state.threads:", w.mh.state.threads.has(KH));
    check(!!adopted && w.mh.state.threads.has(KH) && !w.mh.state.serverSearch.has(KH), "a hub search hit with no server badge is adopted the same way");
    check(w.mh.threadFor("no|such|key") === null, "an unknown key still resolves to nothing");
    w.mh.state.threads.delete(KH); await w.mh.idb.del("threads", KH).catch(() => {});

    q.value = ""; q.dispatchEvent(new w.Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 50));
  }

  { // notification content builders (extracted verbatim from src/index.js): Spark's four preview levels, summary above four
    const src = fs.readFileSync(__dirname + "/../src/index.js", "utf8"); const i0 = src.indexOf("const PREVIEW_LEVELS = "); const i1 = src.indexOf("async function notifyPreview(env)");
    const { mailPush, mailPushSummary } = new Function(src.slice(i0, i1) + "\nreturn { mailPush, mailPushSummary };")();
    const msg = { kind: "gmail", account: "a@gmail.com", thread: "18f", from: "\"Alice Example\" <alice@example.com>", subject: "  Lunch   Friday? ", snippet: "Hey &#39;Sam&#39; — are you free on   Friday &amp; Saturday?", priority: true };
    const full = mailPush("full", msg), subj = mailPush("subject", msg), sender = mailPush("sender", msg), none = mailPush("none", msg), bare = mailPush("full", { ...msg, from: "bob@example.com", snippet: "" });
    console.log("push full:", JSON.stringify([full.title, full.body, full.url]), "| bare:", JSON.stringify([bare.title, bare.body]));
    check(full.title === "Alice Example" && full.body === "Lunch Friday?\nHey 'Sam' — are you free on Friday & Saturday?" && full.url === "/?account=a%40gmail.com&thread=18f" && full.priority === true, "full preview");
    check(subj.body === "Lunch Friday?" && sender.title === "Alice Example" && sender.body === "" && none.title === "New mail in a@gmail.com" && none.body === "", "subject / sender / none levels");
    check(bare.title === "bob@example.com" && bare.body === "Lunch Friday?", "bare address becomes the title, no snippet line");
    const sum = mailPushSummary("full", { kind: "gmail", account: "a@gmail.com", items: [msg, { ...msg, from: "Bob <b@x.io>", subject: "Two" }, { ...msg, from: "Cy <c@x.io>", subject: "Three" }, { ...msg, from: "Di <d@x.io>", subject: "Four" }, { ...msg, from: "Ed <e@x.io>", subject: "Five" }, { ...msg, from: "Fay <f@x.io>", subject: "Six" }] });
    console.log("push summary:", JSON.stringify([sum.title, sum.body]));
    check(sum.title === "6 new in a@gmail.com" && sum.body.split("\n").length === 5 && sum.body.endsWith("+2 more") && sum.body.startsWith("Alice Example: Lunch Friday?"), "summary lists four senders and the rest");
    const sumNone = mailPushSummary("none", { kind: "imap", account: "hub", label: "w@work.com", items: [msg], count: 7 }); check(sumNone.title === "7 new in w@work.com" && sumNone.body === "", "summary at no-preview level");
  }

  { // resurrection fix 1: a window drains the union of queue rows (rows another window wrote to IndexedDB), and drops rows another window completed
    await w.mh.queue.drain(); const hub1 = [...w.mh.state.threads.values()].find((t) => t.kind === "hub" && String(t.id).startsWith("1111"));
    const other = { key: "otherwin-1", createdAt: Date.now(), attempts: 0, status: "pending", notBefore: 0, op: "thread", account: "hub", threadKey: hub1.key, args: { thread: { ...hub1 }, action: "read", before: { unread: hub1.unread } } };
    await w.mh.idb.putAll("queue", [other]); // as if the PWA window had queued it
    const ghost = { key: "ghost-1", createdAt: Date.now(), attempts: 0, status: "pending", notBefore: 0, op: "thread", account: "hub", threadKey: "hub|2222", args: { thread: { id: "22222222-2222-2222-2222-222222222222", key: "hub|2222", kind: "hub", account: "hub" }, action: "read" } };
    w.mh.queue.mem.set("ghost-1", ghost); // in this window's memory only: another window already completed and removed it from IndexedDB
    const before = calls.length; await w.mh.queue.drain(); const after = calls.slice(before);
    const drained = after.some((c) => c === "PATCH /api/threads/11111111-1111-1111-1111-111111111111"); const ghosted = after.some((c) => c.includes("2222"));
    const left = await w.mh.idb.getAll("queue"); console.log("union drain: other window's row persisted:", drained, "| ghost row sent:", ghosted, "| rows left in IndexedDB:", left.length, "| in memory:", w.mh.queue.pending().length);
    check(drained && !ghosted && !left.some((r) => r.key === "otherwin-1") && !w.mh.queue.mem.has("ghost-1"), "union drain persisted the other window's row and dropped the ghost");
  }
  { // resurrection fix 2: a message that is gone for good (404) no longer poisons the delta sync; the cursor commits past it
    const acct = "sam.owner.sxsw@gmail.com"; const st0 = await w.mh.idb.get("state", "state|" + acct); const cursor0 = st0 && st0.historyId;
    w.__mock.routes["GET gmail:history?"] = { history: [{ id: "150", messagesAdded: [{ message: { id: "gm404", threadId: "g404", labelIds: ["INBOX", "UNREAD"] } }] }, { id: "160", labelsRemoved: [{ message: { id: "gm1", threadId: "g1", labelIds: ["CATEGORY_PERSONAL"] }, labelIds: ["INBOX", "UNREAD"] }] }], historyId: "200" };
    w.__mock.routes["GET gmail:messages/gm404?"] = { __status: 404, error: { code: 404, message: "Requested entity was not found." } };
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await new Promise((r) => setTimeout(r, 50)); await w.mh.refresh({ silent: true, accounts: [acct] });
    const st1 = await w.mh.idb.get("state", "state|" + acct); const g1 = w.mh.state.threads.get(acct + "|g1");
    console.log("delta with a 404: cursor", cursor0, "→", st1 && st1.historyId, "| g1 state after labelsRemoved INBOX:", g1 && g1.state, "| unmocked:", w.__mock.errors.filter((e) => /gm404/.test(e)).length);
    check(st1 && st1.historyId === "200" && g1 && g1.state === "archived", "cursor committed past the vanished message and the label record applied");
    w.__mock.routes["GET gmail:history?"] = { history: [], historyId: "200" };
  }
  { // label changes are read and written in one transaction each (idb.getMany), and still applied in history order: the last wins
    const acct = "sam.owner.sxsw@gmail.com"; const k = acct + "|gm2"; const before = await w.mh.idb.get("messages", k);
    w.__mock.routes["GET gmail:history?"] = { history: [{ id: "210", labelsAdded: [{ message: { id: "gm2", threadId: "g2", labelIds: ["INBOX", "UNREAD", "STARRED"] }, labelIds: ["UNREAD", "STARRED"] }] }, { id: "220", labelsRemoved: [{ message: { id: "gm2", threadId: "g2", labelIds: ["INBOX"] }, labelIds: ["UNREAD", "STARRED"] }] }], historyId: "230" };
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await new Promise((r) => setTimeout(r, 50)); await w.mh.refresh({ silent: true, accounts: [acct] });
    const after = await w.mh.idb.get("messages", k); const g2 = w.mh.state.threads.get(acct + "|g2"); const st = await w.mh.idb.get("state", "state|" + acct);
    console.log("batched label changes:", JSON.stringify(before && before.labels), "→", JSON.stringify(after && after.labels), "| g2 unread:", g2 && g2.unread, "starred:", g2 && g2.starred, "| cursor", st && st.historyId);
    check(after && JSON.stringify(after.labels) === '["INBOX"]' && g2 && !g2.unread && !g2.starred && st.historyId === "230", "two label changes to one message in one page: the later one wins, and the thread follows");
    w.__mock.routes["GET gmail:history?"] = { history: [], historyId: "230" };
  }

  { // history gaps: the reconcile lists the last two days and fetches what history never reported; snapshot refuses an older writer
    const acct = "sam.owner.sxsw@gmail.com"; const gap = w.mh.state.threads.get(acct + "|ggap");
    console.log("reconcile: gap thread present after boot:", !!gap, gap ? "| state " + gap.state : "");
    const gap2 = w.mh.state.threads.get(acct + "|ggap2"); console.log("reconcile page 2 thread present:", !!gap2);
    check(gap && gap.state === "inbox" && gap2, "reconcile fetched what history omitted, across pages");
    const threads = [...w.mh.state.threads.values()]; const newest = threads.reduce((m, t) => Math.max(m, t.updatedAt || 0), 0);
    w.localStorage.setItem("mh:snapshot", JSON.stringify({ at: Date.now(), rev: newest + 10_000, threads: [] })); const refused = w.mh.snapshot.write(threads) === false; const still = JSON.parse(w.localStorage.getItem("mh:snapshot")).threads.length === 0;
    w.localStorage.setItem("mh:snapshot", JSON.stringify({ at: Date.now(), rev: 0, threads: [] })); const wrote = w.mh.snapshot.write(threads) === true && JSON.parse(w.localStorage.getItem("mh:snapshot")).threads.length > 0;
    console.log("snapshot rev: older writer refused:", refused && still, "| newer writer wrote:", wrote); check(refused && still && wrote, "snapshot revision guard");
  }

  // Every proxied picture asks for a size (&w=1600 here, a desktop window). The checks below compare whole URLs as they
  // were before sizes; the size is checked once and then taken out of what they read.
  const realProxy = w.mh.proxyImages; let sized = 0, unsized = 0;
  w.mh.proxyImages = (...args) => { const o = realProxy(...args); for (const m of String(o).matchAll(/\/api\/img\?u=[^"'\s)]+/g)) { if (/&w=(1080|1600)(?![0-9])/.test(m[0])) sized++; else unsized++; } return String(o).replace(/&w=(?:1080|1600)(?![0-9])/g, ""); };
  { // bare (unquoted) attribute values are rewritten to the proxy like quoted ones; cid and data stay
    const out = w.mh.proxyImages('<img src=https://www.gstatic.com/x/40px_x4.png height=40><img src="https://a.b/c.png"><td background=https://a.b/bg.jpg><img srcset="https://a.b/1.png 1x, https://a.b/2.png 2x"><img src=data:image/png;base64,AAAA><img src=cid:logo1>', [{ cid: "<logo1>", url: "/api/att/1" }]);
    const bare = /src="\/api\/img\?u=https%3A%2F%2Fwww\.gstatic\.com%2Fx%2F40px_x4\.png" height=40>/.test(out), quoted = /src="\/api\/img\?u=https%3A%2F%2Fa\.b%2Fc\.png"/.test(out), bg = /background="\/api\/img\?u=https%3A%2F%2Fa\.b%2Fbg\.jpg"/.test(out), set = /srcset="\/api\/img\?u=https%3A%2F%2Fa\.b%2F1\.png 1x, \/api\/img\?u=https%3A%2F%2Fa\.b%2F2\.png 2x"/.test(out), data = /src="data:image\/png;base64,AAAA"/.test(out), cid = /src="\/api\/att\/1"/.test(out), raw = /src=https:\/\//.test(out);
    console.log("proxyImages bare attrs:", JSON.stringify({ bare, quoted, bg, set, data, cid, rawLeft: raw }));
    check(bare && quoted && bg && set && data && cid && !raw, "bare src/background/srcset rewritten, data and cid preserved");
  }
  { // a bare value runs to the next whitespace or `>`, `=` and all, as the browser reads it: Google's footer icons are
    // `src=https://…?alt=media&amp;token=…`, which was proxied as `…?alt` with `=media&amp;token=…` left over as junk in the tag
    const out = w.mh.proxyImages('<img src=https://store.example/o/i%2Fgh?alt=media&amp;token=16c3 alt="Visit us" width=33>');
    const whole = out.includes('src="/api/img?u=' + encodeURIComponent("https://store.example/o/i%2Fgh?alt=media&token=16c3") + '" alt="Visit us" width=33>'), junk = /=media|token=16c3[^"]/.test(out.replace(/src="[^"]*"/, ""));
    console.log("proxyImages bare value with '=':", JSON.stringify({ whole, junk }));
    check(whole && !junk, "a bare src holding '=' is proxied whole, nothing left over in the tag");
  }
  { // the attribute is entity-encoded HTML: the proxied URL is the DECODED one (Venmo's resizer 502s on a literal `amp;height`), and a
    // value written back unproxied keeps its entities, so a decoded quote cannot close the attribute
    const out = w.mh.proxyImages('<img src="https://pics-v3.venmo.com/x?width=100&amp;height=100&#38;v=1"><img srcset="https://a.b/1.png?a=1&amp;b=2 1x"><img src="data:image/svg+xml,&quot; onerror=&quot;x">');
    const avatar = out.includes('src="/api/img?u=' + encodeURIComponent("https://pics-v3.venmo.com/x?width=100&height=100&v=1") + '"'), set = out.includes(encodeURIComponent("https://a.b/1.png?a=1&b=2") + " 1x"), stuck = /amp%3B|%2338%3B/.test(out), data = out.includes('src="data:image/svg+xml,&quot; onerror=&quot;x"');
    console.log("proxyImages entities:", JSON.stringify({ avatar, set, stuck, data }));
    check(avatar && set && !stuck && data, "entity-encoded image URLs are decoded before proxying; unproxied values keep their entities");
  }

  { // spy trackers (HEY-style): named vendors and generic pixels are disarmed before anything is fetched; look-alikes survive
    const appSrc = fs.readFileSync(__dirname + "/../src/client/app.js", "utf8"), workerSrc = fs.readFileSync(__dirname + "/../src/index.js", "utf8");
    const table = (x) => (x.match(/const SPY_TRACKERS = \[[\s\S]*?\n\];/) || [""])[0];
    check(table(appSrc) && table(appSrc) === table(workerSrc), "the client's and the Worker's spy-tracker tables are the same");
    const html = `<img src="https://u2.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1">
      <img src="https://trk.example.net/o/xyz" width="1" height="1" style="display:block">
      <img src="https://cdn.example.com/hero.jpg" width="600" height="300">
      <img src="https://cdn.example.com/divider.png" width="600" height="1">
      <img src="https://cdn.example.com/logo-dark.png" width="133" style="display:none">
      <img src="https://cdn.example.com/spacer.gif" width="1" height="1">
      ${'<img src="https://cdn.example.com/dot.gif" width="1" height="1">'.repeat(5)}
      <picture><source srcset="https://ea.pstmrk.it/open?m=1 1x"><img src="https://cdn.example.com/p.png" width="40" height="40"></picture>
      <style>.x{background-image:url(https://xyz.emltrk.com/abc)}</style>`;
    const found = []; const out = w.mh.proxyImages(html, [], found);
    const names = found.map((f) => (f.likely ? "likely:" : "") + f.name).sort();
    const kept = (u) => out.includes(encodeURIComponent(u)), fetched = (u) => out.includes(encodeURIComponent(u)) || out.includes(u);
    console.log("spy trackers:", JSON.stringify(names));
    check(JSON.stringify(names) === JSON.stringify(["Litmus", "Postmark", "SendGrid", "likely:trk.example.net"]), `blocked exactly the trackers (${names})`);
    check(!fetched("https://u2.ct.sendgrid.net/wf/open?upn=abc") && !fetched("https://trk.example.net/o/xyz") && !fetched("https://ea.pstmrk.it/open?m=1") && !fetched("https://xyz.emltrk.com/abc"), "no tracker URL is left in the page, proxied or not");
    check(["hero.jpg", "divider.png", "logo-dark.png", "spacer.gif", "dot.gif", "p.png"].every((f) => kept("https://cdn.example.com/" + f)), "the content image, the 600x1 divider, the hidden logo, the spacer, the repeated dot and the picture fallback all still load");
    check((out.match(/data-mh-tracker=/g) || []).length === 2 && /<img[^>]*src="data:image\/gif[^>]*data-mh-tracker="SendGrid"[^>]*width="1" height="1"/.test(out), "a disarmed pixel keeps its size, as a transparent GIF");
    const note = w.eval('messageHtml({ html: \'<p>hi</p><img src="https://ea.pstmrk.it/open?x" width="1" height="1">\', from: "a@b.c", to: "me@x.y", date: Date.now() }, 0, 1, [])');
    check(/class="trk"[\s\S]*Blocked a spy tracker from Postmark/.test(note), "the message says who was tracking");
    check(!/class="trk"/.test(w.eval('messageHtml({ html: "<p>clean</p>", from: "a@b.c", to: "me@x.y", date: Date.now() }, 0, 1, [])')), "a clean mail says nothing (never a false 'protected')");
  }
  { // the hub's blocks beyond the named list: synced as URL hashes, an ad removed with its link, the note says so
    const AD = "https://slots.publisher.example/imp?s=123456&li=1", PX = "https://px.mailer.example/o/AAAA1111bbbb2222.gif";
    w.__mock.routes["GET /api/trackers?"] = { seq: 2, rows: [[w.mh.urlHash(AD), "LiveIntent", "ad", 0], [w.mh.urlHash(PX), "mailer.example", "tracker", 0]], more: false };
    await w.mh.syncTrackers({ force: true });
    const found = [], out = w.mh.proxyImages(`<p>Story</p><a href="https://slots.publisher.example/click?s=1"><img src="${AD.replace(/&/g, "&amp;")}" width="300" height="250"></a><img src="${PX}">`, [], found);
    check(!out.includes("slots.publisher.example") && !out.includes("px.mailer.example") && /<mh-gone[^>]*><\/mh-gone>/.test(out), `a synced ad is removed with its link and a synced pixel disarmed, neither asked of the hub (${out.slice(0, 160)})`);
    check(found.some((f) => f.cls === "ad" && f.name === "LiveIntent") && found.some((f) => f.cls === "tracker" && f.name === "mailer.example"), "each block carries its name and class");
    const note = w.eval(`messageHtml({ html: '<a href="https://slots.publisher.example/c"><img src="${AD.replace(/&/g, "&amp;")}" width="300" height="250"></a><img src="https://ea.pstmrk.it/open?x" width="1" height="1">', from: "a@b.c", to: "me@x.y", date: Date.now() }, 0, 1, [])`);
    check(/Blocked a spy tracker from Postmark and an ad from LiveIntent/.test(note), "the message names the tracker and the ad");
    w.__mock.routes["GET /api/trackers?"] = { seq: 3, rows: [[w.mh.urlHash(AD), "LiveIntent", "ad", 1]], more: false };
    await w.mh.syncTrackers({ force: true });
    const back = w.mh.proxyImages(`<img src="${AD.replace(/&/g, "&amp;")}" width="300" height="250">`, [], []);
    check(back.includes(encodeURIComponent(AD)), "a withdrawn block (Undo) shows the picture again");
    w.__mock.routes["GET /api/trackers?"] = { seq: 0, rows: [], more: false };
  }
  { // the device's speed report reaches the hub, at most every six hours
    w.mh.perf.record("smoke:probe", 12);
    try { w.localStorage.removeItem("mh:speedAt"); } catch (_) {}
    const before = calls.filter((c) => c === "POST /api/perf").length;
    const first = await w.mh.sendSpeedReport(), second = await w.mh.sendSpeedReport();
    const sent = calls.filter((c) => c === "POST /api/perf").length - before;
    check(first === true && second === false && sent === 1, `the speed report is sent once, then held for six hours (${first}, ${second}, ${sent} sent)`);
  }
  { // srcset per HTML's grammar: a URL may contain commas (Substack's do), so candidates split at the comma after the descriptor
    const sub = "https://substackcdn.com/image/fetch/$s_!DIki!,w_131,c_limit,f_auto/https%3A%2F%2Fsubstack.com%2Fimg%2Fa.png";
    const out = w.mh.proxyImages(`<img srcset="${sub}, https://a.b/2.png 2x" src="https://a.b/1.png" width="40" height="40">`, []);
    check(out.includes(`srcset="/api/img?u=${encodeURIComponent(sub)}, /api/img?u=${encodeURIComponent("https://a.b/2.png")} 2x"`), "a srcset URL containing commas is proxied whole, not in fragments");
  }
  { // Srcset siblings, style="…" url(), the generic rule's two sides, <picture> sources, relative URLs, the key
    const found = [];
    const out = w.mh.proxyImages(`<img srcset="https://ea.pstmrk.it/open?m=1 1x, https://cdn.example.com/2x.png 2x" src="https://cdn.example.com/1x.png" width="40" height="40">
      <div id="bg" style="background-image:url('https://cdn.example.com/bg.png?a=1&amp;b=2');color:red">x</div>
      <style>.s{background:url(https://cdn.example.com/s.png?a=1&amp;b=2)}</style>
      <img src="https://cdn.example.com/vline.png" style="width:1px;height:40px"><img src="https://t.example.org/p.gif" style="width:1px;height:1px">
      <picture><source srcset="https://cdn.example.com/hero.webp"><img src="https://cdn.example.com/hero.png" width="600" height="300"></picture>
      <img id="rel1" src="/api/img?u=https%3A%2F%2Fattacker.example%2Fx"><img id="rel2" src="relative.png">`, [], found);
    const enc = encodeURIComponent, doc = new w.DOMParser().parseFromString(out, "text/html");
    const style = doc.getElementById("bg")?.getAttribute("style") || "";
    check(out.includes(enc("https://cdn.example.com/2x.png") + " 2x") && !out.includes("pstmrk"), "a tracker inside a srcset goes, its legitimate sibling stays");
    check(style.includes("url(/api/img?u=" + enc("https://cdn.example.com/bg.png?a=1&b=2") + ")") && /color:\s*red/.test(style), `a url() inside style="…" keeps the attribute whole and is entity-decoded (${style.slice(0, 120)})`);
    check(out.includes(enc("https://cdn.example.com/s.png?a=1&amp;b=2")), "a url() in a <style> element is taken as written (the parser does not decode entities there)");
    check(out.includes(enc("https://cdn.example.com/vline.png")) && found.some((f) => f.likely && f.name === "t.example.org") && !out.includes("t.example.org/p.gif"), `one 1 px side is a rule, not a pixel; both sides 1 px is (${JSON.stringify(found.map((f) => f.name))})`);
    check(out.includes('srcset="/api/img?u=' + enc("https://cdn.example.com/hero.webp")), "a <picture> source is proxied (the browser picks it; a refused source is a broken image, not a fallback)");
    check(doc.getElementById("rel1")?.getAttribute("src") === "" && doc.getElementById("rel2")?.getAttribute("src") === "", "a mail's relative image URLs are dropped (they could only resolve against the app's origin)");
    w.mh.setImgPass("KEY0123456789abcdefghij");   // what boot does with /api/me's img_key
    const keyed = w.mh.proxyImages('<img src="https://cdn.example.com/k.png"><div style="background:url(https://cdn.example.com/kb.png)"><img srcset="https://cdn.example.com/s1.png 1x, https://cdn.example.com/s2.png 2x">', []);
    let kept = null; try { kept = w.localStorage.getItem("mh:ik"); } catch (_) {}
    // <link> is inert in a mail (WebKit honours preconnect and dns-prefetch under the CSP), cid: images carry the key, and the frame
    // turns DNS prefetching off and may load images only from the three image routes
    const links = w.mh.proxyImages('<svg><link rel="dns-prefetch" href="//t4.example"/></svg><table><link rel="preconnect" href="//t5.example"></table><template><link rel="preconnect" href="//t6.example"></template><link rel="preconnect" href="https://t.example/"><LINK\nrel=dns-prefetch href=//t2.example><link/rel=prefetch href=//t3.example><img src="cid:logo1"><img src="cid:g1">', [{ cid: "<logo1>", url: "/api/att/1" }, { cid: "<g1>", url: "/api/gmail/att/a%40b.c/m/x?mime=image%2Fpng" }]);
    check(!/<link/i.test(links) && (links.match(/<mh-link/g) || []).length === 6, `every <link> in a mail is made inert (${links.slice(0, 90)})`);
    check(links.includes('src="/api/att/1?k=KEY0123456789abcdefghij"') && links.includes("mime=image%2Fpng&k=KEY0123456789abcdefghij"), "an attachment image the app writes carries the key");
    const ti = []; const tiOut = w.mh.proxyImages("<img src='https://e2e.ti.com/notification/read?NotificationId=00000000-0000-0000-0000-000000000000' style='max-width:100%'>", [], ti);
    check(ti.some((f) => f.name === "Texas Instruments" && !f.likely) && !tiOut.includes("e2e.ti.com"), `TI's E2E read receipt is blocked by name (${JSON.stringify(ti)})`);
    const docs = []; w.eval("messageHtml")({ html: "<p>x</p>", from: "a@b.c", to: "me@x.y", date: Date.now() }, 0, 1, docs);
    const csp = (docs[0] || "").match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || "";
    check(/x-dns-prefetch-control" content="off"/.test(docs[0] || "") && /img-src data: https:\/\/mail\.yourdomain\.example\/api\/img https:\/\/mail\.yourdomain\.example\/api\/att\/ https:\/\/mail\.yourdomain\.example\/api\/gmail\/att\/;/.test(csp) && !/'self'/.test(csp), `the frame turns DNS prefetch off and allows images from the image routes only (${csp})`);
    check(keyed.includes('src="/api/img?u=' + enc("https://cdn.example.com/k.png") + '&k=KEY0123456789abcdefghij"') && keyed.includes(enc("https://cdn.example.com/kb.png") + "&k=KEY0123456789abcdefghij)") && keyed.includes(enc("https://cdn.example.com/s2.png") + "&k=KEY0123456789abcdefghij 2x"), `every URL the app writes carries the image key, and it is kept for the next cold boot (${kept})`);
  }
  w.mh.proxyImages = realProxy;
  check(sized > 10 && unsized === 0, `every picture the app proxies asks for a size (${sized} sized, ${unsized} without)`);
  { // link cleaning: tracking tags off, encoding kept, unsubscribe / signed / opaque links untouched, Google and SafeLinks unwrapped
    const cases = [
      ["https://shop.example.com/p?id=7&utm_source=nl&utm_medium=email&fbclid=x#frag", "https://shop.example.com/p?id=7#frag"],
      ["https://a.com/?q=a+b%20c&utm_campaign=z&sig=AbC%2Fd%3D", "https://a.com/?q=a+b%20c&sig=AbC%2Fd%3D"],
      ["https://x.com/unsubscribe?mkt_tok=abc&utm_source=a", "https://x.com/unsubscribe?mkt_tok=abc&utm_source=a"],
      ["https://urldefense.com/v3/__https://x.com__;!!abc$?utm_source=a", "https://urldefense.com/v3/__https://x.com__;!!abc$?utm_source=a"],
      ["https://www.google.com/url?q=https%3A%2F%2Fsite.com%2Fa%3Futm_source%3Dx%26k%3D1&sa=D", "https://site.com/a?k=1"],
      ["https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.org%2Fdoc&data=05", "https://example.org/doc"],
      ["https://u00000000.ct.sendgrid.net/ls/click?upn=u001.abc", "https://u00000000.ct.sendgrid.net/ls/click?upn=u001.abc"],
      ["https://www.example.com/plain", "https://www.example.com/plain"],
    ];
    const wrong = cases.filter(([i, o]) => w.eval("cleanLink")(i) !== o).map(([i]) => i + " -> " + w.eval("cleanLink")(i));
    console.log("link cleaning:", cases.length - wrong.length, "/", cases.length); check(!wrong.length, "link cleaning cases: " + wrong.join("; "));
  }
  { // updates apply themselves: a new version reloads when idle, waits (with a bar) while a reply is being written, then applies when it empties
    let reloads = 0; w.mh.update.reload = () => { reloads++; }; await w.mh.queue.drain(); doc.querySelector("#cmodal").classList.remove("on"); doc.querySelector("#ctext").value = ""; // the earlier send test left a reopened draft, which rightly blocks an update
    w.__mock.routes["GET /api/version"] = { version: "test-next" }; doc.querySelector("#rtext").value = "half-written reply";
    await w.mh.checkVersion(); await new Promise((r) => setTimeout(r, 400));
    const barShown = !!doc.querySelector("#upd"); const heldBack = reloads === 0;
    Object.defineProperty(doc, "hidden", { value: true, configurable: true }); w.mh.applyUpdate(); await new Promise((r) => setTimeout(r, 300)); const heldHidden = reloads === 0; Object.defineProperty(doc, "hidden", { value: false, configurable: true });
    doc.querySelector("#rtext").value = ""; w.mh.applyUpdate(); await new Promise((r) => setTimeout(r, 400));
    console.log("auto-update: held while typing:", heldBack, "| held while hidden with text:", heldHidden, "| bar:", barShown, "| reloaded once idle:", reloads === 1); check(heldHidden, "hidden tab with typed text is not reloaded");
    check(heldBack && barShown && reloads === 1, "update waits for an idle moment then reloads");
    w.mh.update.reloading = false; w.mh.update.armed = false; doc.querySelector("#upd")?.remove(); w.mh.applyUpdate(); await new Promise((r) => setTimeout(r, 300)); const second = reloads; w.mh.update.reloading = false; w.mh.applyUpdate(); await new Promise((r) => setTimeout(r, 300));
    console.log("reload-loop guard: reloads after two tries:", reloads, "(bar shown instead:", !!doc.querySelector("#upd"), ")"); check(second === 2 && reloads === 2, "a third automatic reload for the same version is refused");
    w.__mock.routes["GET /api/version"] = { version: "test" }; w.mh.update.version = null; w.mh.update.reloading = false; clearInterval(w.mh.update.timer); w.sessionStorage.removeItem("mh:upd");
  }

  { // a stale undo is dropped, a fresh one is sent; Discard rolls the row back and forgets the action
    await w.mh.queue.drain(); const hub1 = [...w.mh.state.threads.values()].find((t) => t.kind === "hub" && String(t.id).startsWith("1111"));
    hub1.state = "inbox"; const stale = { key: "stale-undo", createdAt: Date.now() - 20 * 60_000, attempts: 0, status: "pending", notBefore: 0, op: "thread", account: "hub", threadKey: hub1.key, args: { action: "restore", undo: true, thread: { ...hub1 }, before: { state: "archived", unread: false, starred: false }, expect: { state: "archived" } } };
    const next = { key: "after-stale", createdAt: Date.now(), attempts: 0, status: "pending", notBefore: 0, op: "thread", account: "hub", threadKey: hub1.key, args: { action: "read", thread: { ...hub1 } } }; w.mh.queue.mem.set(next.key, next); await w.mh.idb.putAll("queue", [next]);
    const fresh = { key: "fresh-undo", createdAt: Date.now() - 60_000, attempts: 0, status: "pending", notBefore: 0, op: "thread", account: "hub", threadKey: "hub|3333", args: { action: "restore", undo: true, thread: { id: "33333333-3333-3333-3333-333333333333", key: "hub|3333", kind: "hub", account: "hub" } } };
    w.mh.queue.mem.set(stale.key, stale); w.mh.queue.mem.set(fresh.key, fresh); await w.mh.idb.putAll("queue", [stale, fresh]);
    const before = calls.length; await w.mh.queue.drain(); const after = calls.slice(before);
    const staleSent = after.some((c) => c.includes("11111111")), freshSent = after.some((c) => c.includes("33333333"));
    const laneWent = after.filter((c) => c.includes("11111111")).length === 1; // the stale undo was not sent, the newer action on the same thread was
    console.log("stale undo sent:", !laneWent && staleSent, "| next action on that lane sent:", laneWent, "| local state rolled back:", hub1.state, "| fresh undo sent:", freshSent, "| left:", w.mh.queue.pending().length);
    check(laneWent && hub1.state === "archived" && freshSent && w.mh.queue.pending().length === 0, "stale undo dropped with local rollback, lane continued, fresh undo sent");
    { // conditional undo: the server says inbox, the undo expected archived → skipped, local follows the server, nothing sent
      const t2 = [...w.mh.state.threads.values()].find((t) => t.kind === "hub" && String(t.id).startsWith("2222")); t2.state = "archived";
      const cond = { key: "cond-undo", createdAt: Date.now(), attempts: 0, status: "pending", notBefore: 0, op: "thread", account: "hub", threadKey: t2.key, args: { action: "restore", undo: true, thread: { ...t2 }, before: { state: "archived" }, expect: { state: "archived" } } };
      w.mh.queue.mem.set(cond.key, cond); await w.mh.idb.putAll("queue", [cond]); const b2 = calls.length; await w.mh.queue.drain(); const a2 = calls.slice(b2);
      console.log("conditional undo: PATCH sent:", a2.some((c) => c.startsWith("PATCH") && c.includes("2222")), "| read server state:", a2.some((c) => c === "GET /api/threads/22222222-2222-2222-2222-222222222222"), "| local now:", t2.state);
      check(!a2.some((c) => c.startsWith("PATCH") && c.includes("2222")) && t2.state === "inbox" && !w.mh.queue.pending().length, "undo skipped because the server had moved on; local follows the server");
    }
    const t4 = [...w.mh.state.threads.values()].find((t) => t.kind === "hub" && String(t.id).startsWith("4444")); const was = t4.state;
    w.mh.applyLocal(t4, "archive"); const row = await w.mh.queue.add({ op: "thread", account: "hub", threadKey: t4.key, args: { action: "archive", thread: { ...t4 }, before: { state: was, unread: t4.unread, starred: t4.starred } } });
    await w.mh.queue.discard(row.key); console.log("discard: state back to", t4.state, "| pending:", w.mh.queue.pending().length, "| in idb:", (await w.mh.idb.getAll("queue")).length);
    check(t4.state === was && !w.mh.queue.pending().length, "discard rolled the row back and removed the action");
  }
  { // push: the device's own subscription must be re-registered with the hub, or a pruned/rotated row leaves push silently off forever
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    let stored = null; const fakeSub = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }) };
    const swStub = (sub) => ({ ready: Promise.resolve({ pushManager: { getSubscription: async () => sub } }), getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }), register: () => Promise.resolve(), addEventListener() {} });
    Object.defineProperty(w.navigator, "serviceWorker", { value: swStub(fakeSub), configurable: true });
    const c0 = calls.length; const id = await w.mh.syncPushSubscription(); const after = calls.slice(c0);
    const post = after.find((c) => c === "POST /api/push/subscribe");
    console.log("push re-register: id", id, "| POST sent:", !!post, "| remembered:", w.mh.myPushId());
    check(id === "sub-1" && !!post, `the device re-registered its own subscription (id ${id}, post ${!!post})`);
    check(w.mh.myPushId() === "sub-1", `and remembers which registered device it is (${w.mh.myPushId()})`);
    Object.defineProperty(w.navigator, "serviceWorker", { value: swStub(null), configurable: true });
    const c1 = calls.length; const none = await w.mh.syncPushSubscription();
    console.log("push re-register with nothing subscribed:", none, "| calls made:", calls.length - c1);
    check(none === null && calls.length === c1, "a device with no subscription, and no permission, sends nothing");

    // A 410 DESTROYS the subscription, so the pruned device boots with getSubscription() === null and has nothing to
    // re-register. Re-registering alone left the user's phone silent 2026-09-13..17. With permission already granted it must
    // subscribe outright, and must NOT do so when notifications were switched off by hand.
    const subStub = (sub, made) => ({ ready: Promise.resolve({ pushManager: { getSubscription: async () => sub, subscribe: async (o) => { made.push(o); return fakeSub; } } }),
      getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }), register: () => Promise.resolve(), addEventListener() {} });
    const perm = (v) => Object.defineProperty(w, "Notification", { value: { permission: v, requestPermission: async () => v }, configurable: true });
    try { w.localStorage.removeItem("mh_push_off"); } catch (_) {}

    perm("granted"); let made = [];
    Object.defineProperty(w.navigator, "serviceWorker", { value: subStub(null, made), configurable: true });
    const c2 = calls.length; const healed = await w.mh.syncPushSubscription();
    const posted = calls.slice(c2).includes("POST /api/push/subscribe");
    console.log("R38 permission granted, nothing subscribed:", healed, "| subscribe() calls:", made.length, "| POST sent:", posted);
    check(made.length === 1 && made[0] && made[0].userVisibleOnly === true, `it subscribes itself (${made.length} subscribe call(s))`);
    check(healed === "sub-1" && posted, `and registers the new subscription with the hub (id ${healed}, post ${posted})`);

    // switched off by hand: unsubscribe() cannot revoke the permission, so without the opt-out flag every boot would undo it
    try { w.localStorage.setItem("mh_push_off", "1"); } catch (_) {}
    made = []; Object.defineProperty(w.navigator, "serviceWorker", { value: subStub(null, made), configurable: true });
    const c3 = calls.length; const offed = await w.mh.syncPushSubscription();
    console.log("R38 notifications switched off by hand:", offed, "| subscribe() calls:", made.length, "| calls made:", calls.length - c3);
    check(w.mh.pushOptOut() === true, "the deliberate opt-out is remembered");
    check(made.length === 0 && offed === null && calls.length === c3, "a device switched off by hand is NOT re-subscribed behind the user's back");
    try { w.localStorage.removeItem("mh_push_off"); } catch (_) {}

    // permission not granted: subscribe() would throw, and asking for permission without a gesture is not ours to do
    perm("default"); made = [];
    Object.defineProperty(w.navigator, "serviceWorker", { value: subStub(null, made), configurable: true });
    const c4 = calls.length; const nope = await w.mh.syncPushSubscription();
    console.log("R38 permission not granted:", nope, "| subscribe() calls:", made.length);
    check(made.length === 0 && nope === null && calls.length === c4, "a device that has not granted permission is left alone");
    perm("granted");
    Object.defineProperty(w.navigator, "serviceWorker", { value: undefined, configurable: true });
    check((await w.mh.syncPushSubscription()) === null, "a browser without service workers is survived, not thrown");
    // `serviceWorker.ready` never settles when no worker ever activates, and openSettings awaits this before it renders
    Object.defineProperty(w.navigator, "serviceWorker", { value: { ready: new Promise(() => {}), getRegistration: async () => null, register: () => Promise.resolve(), addEventListener() {} }, configurable: true });
    const t0 = Date.now(); const hung = await w.mh.syncPushSubscription(); const waited = Date.now() - t0;
    console.log("push re-register when the worker never activates:", hung, "| gave up after", waited, "ms");
    check(hung === null && waited < 6000, `a worker that never activates times out instead of hanging Settings (${waited} ms)`);
    Object.defineProperty(w.navigator, "serviceWorker", { value: undefined, configurable: true });
  }
  { // the conversation the service worker pulled down at push time must open with NO network call and no "Loading…"
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const t = [...w.mh.state.threads.values()].find((x) => x.kind === "hub" && x.id);
    // the push is about the conversation's NEWEST message, so the stash must carry that id: cachedThread() rejects a cache that
    // does not contain t.lastMsgId as stale, which is exactly right and is why this id is not made up
    const pfId = t.lastMsgId || "pf-1";
    const raw = { thread: { id: t.id }, messages: [{ id: pfId, direction: "in", from_addr: "pushed@example.com", from_name: "Pushed Sender",
      to_addrs: [], cc_addrs: [], created_at: "2026-09-17T22:00:00.000Z", subject: "Arrived with the notification",
      body_text: "the body was already on the device", body_html: "<p>the body was already on the device</p>", attachments: [], labels: "[]" }] };
    await w.mh.idb.putAll("meta", [{ k: "pf:" + t.key, v: { kind: "hub", account: "hub", id: t.id, raw, at: Date.now() } }]);
    await w.mh.idb.delAll("bodies", (await w.mh.idb.getByIndex("bodies", "threadKey", t.key)).map((r) => r.key)).catch(() => {});
    w.mh.prerendered.delete(t.key);
    const c0 = calls.length;
    const d = await w.mh.pushedThread(t);
    const netAfter = calls.slice(c0).filter((c) => String(c).includes("/api/threads/"));
    console.log("pushed thread claimed:", !!d, "| subject:", d && d.messages[0].subject, "| network calls:", netAfter.length);
    check(!!d && d.messages[0].subject === "Arrived with the notification", "the pushed conversation is parsed by the account's own normalize()");
    check(netAfter.length === 0, `and claiming it cost no network call (${netAfter.length})`);
    const cached = await w.mh.idb.getByIndex("bodies", "threadKey", t.key);
    check(cached.length === 1, `it lands in the body cache, so it survives a reload (${cached.length} row)`);
    check((await w.mh.idb.get("meta", "pf:" + t.key)) === undefined, "and the stash is cleared once claimed, never served twice");
    check((await w.mh.pushedThread(t)) === null, "a second claim finds nothing");
    // a stash older than a day is not trusted: the conversation has probably moved on
    await w.mh.idb.putAll("meta", [{ k: "pf:" + t.key, v: { kind: "hub", account: "hub", id: t.id, raw, at: Date.now() - 36 * 3600e3 } }]);
    check((await w.mh.pushedThread(t)) === null, "a stale stash is discarded rather than rendered");
    check((await w.mh.idb.get("meta", "pf:" + t.key)) === undefined, "and it does not linger after being discarded");

    // A reply that lands between the prefetch and the tap must not be silently
    // missing. t.lastMsgId is the authority, and the stash has to contain it or it is out of date.
    const behind = JSON.parse(JSON.stringify(raw)); behind.messages[0].id = "older-than-the-row";
    await w.mh.idb.putAll("meta", [{ k: "pf:" + t.key, v: { kind: "hub", account: "hub", id: t.id, raw: behind, at: Date.now() } }]);
    const wasLast = t.lastMsgId; t.lastMsgId = "a-newer-message-arrived";
    const stale = await w.mh.pushedThread(t);
    console.log("stash missing the row's newest message:", stale);
    check(stale === null, "a stash that does not contain t.lastMsgId is refused, not rendered");
    check((await w.mh.idb.get("meta", "pf:" + t.key)) === undefined, "and that stash is dropped so it cannot be served later");
    t.lastMsgId = wasLast;

    // unclaimed stashes must not accumulate on a device that ignores its notifications
    await w.mh.idb.putAll("meta", [{ k: "pf:never-opened|1", v: { kind: "hub", account: "hub", id: "1", raw, at: Date.now() - 48 * 3600e3 } },
                                    { k: "pf:recent|2", v: { kind: "hub", account: "hub", id: "2", raw, at: Date.now() } }]);
    await w.mh.sweepPushStash();
    check((await w.mh.idb.get("meta", "pf:never-opened|1")) === undefined, "the boot sweep removes an unclaimed stash past its age");
    check((await w.mh.idb.get("meta", "pf:recent|2")) !== undefined, "and leaves a fresh one alone");
    await w.mh.idb.del("meta", "pf:recent|2").catch(() => {});

    // threshold (vi): the opt-out has to survive a failing unsubscribe, and gate the re-POST path too
    await w.mh.setPushOptOut(true);
    check(w.mh.pushOptOut() === true && (await w.mh.idb.meta("push_off")) === 1, "the opt-out is mirrored where the service worker can read it");
    const c9 = calls.length;
    const heldSub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } }) };
    Object.defineProperty(w.navigator, "serviceWorker", { value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => heldSub } }),
      getRegistration: async () => ({ pushManager: { getSubscription: async () => heldSub } }), register: () => Promise.resolve(), addEventListener() {} }, configurable: true });
    const refused = await w.mh.syncPushSubscription();
    check(refused === null && calls.length === c9, "an opted-out device does not even RE-POST the subscription it still holds");
    await w.mh.setPushOptOut(false);
    // the body cache itself: the index that made cachedThread() a permanent miss until 2026-09-17
    const hit = await w.mh.cachedThread(t);
    console.log("body cache readable:", !!hit, "| messages:", hit && hit.messages.length);
    check(!!hit && hit.cached === true, "the body cache is READABLE (bodies.threadKey index, store v4) — it was write-only before");
  }
  { // One round trip instead of seven, and it must degrade to the old path rather than fail
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const SEVEN = ["GET /api/me", "GET /api/gmail/accounts", "GET /api/prefs", "GET /api/push/config", "GET /api/sender-rules", "GET /api/schedule?status=pending", "GET /api/senders?status=pending"];
    const c0 = calls.length;
    const b = await w.mh.bootstrapAll();
    const made = calls.slice(c0);
    console.log("bootstrap: requests", made.length, "| individual endpoints hit:", made.filter((c) => SEVEN.includes(c)).length);
    check(made.length === 1 && made[0] === "GET /api/bootstrap", `boot is ONE request, not seven (${made.length}: ${made.join(", ")})`);
    check(!made.some((c) => SEVEN.includes(c)), "and none of the seven individual endpoints is called");
    check(b.me.identities.length > 0 && b.g.accounts.length > 0 && b.pc.public_key && b.version === "test",
      "every field the boot needs arrives, including the version that was an eighth request");

    // one part failing must not fail the boot, nor silently blank that part
    const saved = w.__mock.routes["GET /api/bootstrap"];
    w.__mock.routes["GET /api/bootstrap"] = { ...saved, gmail: { __error: "d1 timeout" }, prefs: { __error: "d1 timeout" } };
    const c1 = calls.length; const partial = await w.mh.bootstrapAll(); const made1 = calls.slice(c1);
    console.log("partial bootstrap: fell back to", made1.filter((c) => SEVEN.includes(c)));
    check(made1.includes("GET /api/gmail/accounts") && made1.includes("GET /api/prefs"), "a field reported __error falls back to its own endpoint");
    check(!made1.includes("GET /api/me") && !made1.includes("GET /api/sender-rules"), "and the fields that DID arrive are not re-fetched");
    check(partial.g.accounts.length > 0 && partial.me.identities.length > 0, "the boot still gets everything it needs");

    // a hub that has never heard of /api/bootstrap (older deploy) must still boot
    delete w.__mock.routes["GET /api/bootstrap"];
    const c2 = calls.length; const old = await w.mh.bootstrapAll(); const made2 = calls.slice(c2);
    check(SEVEN.every((e) => made2.includes(e)), `with no /api/bootstrap at all, all seven are used (${made2.filter((c) => SEVEN.includes(c)).length}/7)`);
    check(old.me.identities.length > 0 && old.g.accounts.length > 0, "and the boot is identical to before R36");
    w.__mock.routes["GET /api/bootstrap"] = saved;
  }
  { // one row leaving must not rebuild the whole window. Measured on the phone: act:phase:removeFromList p50 52 ms per action,
    // 97 actions in one session, and act:trash p50 389 ms against a 23 ms network call. Timing this in a fake harness would prove
    // nothing, so this asserts the STRUCTURE: the row goes, and render() is not called to make that happen.
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const doc = w.document;
    // earlier blocks leave a search term and a selection behind; both legitimately force a full render, so clear them first
    w.mh.state.search = ""; w.mh.state.searchHits = null; w.mh.state.selecting = false; w.mh.state.checked.clear();
    w.mh.render();
    const rows = [...doc.querySelectorAll("#threads .t")];
    if (rows.length >= 2) {
      const key = rows[0].dataset.key;
      const before = doc.querySelectorAll("#threads .t").length;
      // Spying on w.mh.render would prove nothing: the module calls its own `render`, not the exported reference. So this
      // asserts the observable consequence instead: render() does `el.innerHTML = ""`, which DESTROYS every row node, so a
      // surviving row keeping its identity is proof the window was not rebuilt.
      const survivor = rows[1]; const survivorKey = survivor.dataset.key;
      const dropped = w.mh.dropRowNode(key);
      const after = doc.querySelectorAll("#threads .t").length;
      const stillSame = [...doc.querySelectorAll("#threads .t")].find((d) => d.dataset.key === survivorKey) === survivor;
      console.log("drop one row:", dropped, "| rows", before, "->", after, "| neighbour node kept identity:", stillSame);
      check(dropped === true, "a rendered row is removed directly");
      check(after === before - 1, `exactly one row leaves the DOM (${before} -> ${after})`);
      check(stillSame, "and the surviving rows are the SAME nodes — the 80-row window was not rebuilt");
      // render() was what re-primed the body prefetch window; replacing it here must not quietly drop that, or clearing the
      // inbox from the top pulls unfetched rows into view and the next tap pays a full network body fetch.
      const before2 = w.mh.prefetchBodies.calls || 0;
      const rows2 = [...doc.querySelectorAll("#threads .t")];
      if (rows2.length) { w.mh.dropRowNode(rows2[0].dataset.key); await new Promise((r) => setTimeout(r, 350)); } // scheduleIdle falls back to a 200 ms timeout
      const primed = (w.mh.prefetchBodies.calls || 0) - before2;
      console.log("drop re-primes prefetch:", primed > 0, `(${primed} call(s))`);
      check(primed > 0, "removing a row re-primes the body prefetch window (render() used to do this, dropRowNode must too)");
      check(![...doc.querySelectorAll("#threads .t")].some((d) => d.dataset.key === key), "the row that left is gone from the list");
    }
  }
  { // the snapshot is what paints the next cold boot (119 ms on the phone). Moving it off the refresh path must NOT lose it.
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const real = w.mh.snapshot.write.bind(w.mh.snapshot); let writes = 0;
    w.mh.snapshot.write = (...a) => { writes++; return real(...a); };
    w.mh.markSnapshotDirty();
    const afterDirty = writes;
    console.log("snapshot: writes during refresh-path marking:", afterDirty);
    check(afterDirty === 0, `marking dirty does not write synchronously (${afterDirty} writes)`);

    // the page going away is the moment it must be durable
    Object.defineProperty(w.document, "hidden", { value: true, configurable: true });
    w.dispatchEvent(new w.Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));
    console.log("snapshot: writes after the page is hidden:", writes);
    check(writes === 1, `going hidden flushes exactly one snapshot write (${writes})`);
    const snap = w.mh.snapshot.read();
    check(!!snap && Array.isArray(snap.threads) && snap.threads.length > 0, `and the next boot can still paint from it (${snap && snap.threads ? snap.threads.length : 0} rows)`);

    // a second hide with nothing new must not rewrite it
    w.dispatchEvent(new w.Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));
    check(writes === 1, `a hide with nothing dirty writes nothing further (${writes})`);
    Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
    w.mh.snapshot.write = real;
  }
  { // the 60 s poll cost 953 ms of mostly network every minute. It may only back off when push really can deliver instead.
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const st = w.mh.state; const savedPush = st.push, savedGmail = st.gmail;
    const future = new Date(Date.now() + 5 * 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();

    st.push = { configured: true }; try { w.localStorage.setItem("mh_push_id", "sub-1"); } catch (_) {}
    st.gmail = [{ email: "a@gmail.com", status: "active", watch_expiration: future }];
    check(w.mh.pushLive() === true, "push counts as live when every active account has an unexpired watch and the device is registered");

    st.gmail = [{ email: "a@gmail.com", status: "active", watch_expiration: future }, { email: "b@gmail.com", status: "active", watch_expiration: past }];
    check(w.mh.pushLive() === false, "one EXPIRED watch is enough to keep polling at a minute");

    st.gmail = [{ email: "a@gmail.com", status: "active", watch_expiration: future }];
    try { w.localStorage.removeItem("mh_push_id"); } catch (_) {}
    check(w.mh.pushLive() === false, "a device the hub has no push route to keeps polling, however healthy the watches are");

    try { w.localStorage.setItem("mh_push_id", "sub-1"); } catch (_) {}
    st.push = { configured: false };
    check(w.mh.pushLive() === false, "and push being unconfigured on the Worker keeps polling");

    st.push = { configured: true }; st.gmail = [];
    check(w.mh.pushLive() === false, "no active account is not 'push is live'");

    // trust is EARNED: a live watch says push is configured, not that it is delivering
    st.gmail = [{ email: "a@gmail.com", status: "active", watch_expiration: future }];
    check(w.mh.pushLive() === true, "back to live before the watchdog test");
    w.mh.notePushMissed("test");
    check(w.mh.pushLive() === false, "a poll that finds mail push should have delivered withdraws the backoff");
    w.mh.notePushDelivered();
    check(w.mh.pushLive() === true, "and an actual delivery restores it immediately");

    // the watchdog must only judge an interval this page was awake for, or it convicts push of misses it never had
    const st2 = w.mh.state;
    st2.lastPollStartedAt = 0; st2.hiddenSincePoll = false;
    const c0 = calls.length; await w.mh.refresh({ silent: true });
    check(w.mh.pushLive() === true, "the FIRST poll of a session never convicts push (it legitimately syncs what arrived while closed)");

    st2.lastPollStartedAt = Date.now() - 60_000; st2.hiddenSincePoll = true;
    await w.mh.refresh({ silent: true });
    check(w.mh.pushLive() === true, "and neither does a poll spanning time the page was HIDDEN (the worker got the push, no page to tell)");
    st2.hiddenSincePoll = false;
    console.log("watchdog false-positive gates: first-poll and hidden-interval both held", calls.length - c0, "calls");
    st.push = savedPush; st.gmail = savedGmail;
    console.log("poll backoff gate: exercised 5 states");
  }
  { // the user's Mac sat on an old build all day: ONE undrainable action made updateSafe() false for ever
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const upd = w.mh.update; const savedHeld = upd.heldSince;
    // stub a permanently undrainable action: exactly what an unreachable work mailbox leaves behind. `queue` is a shared object,
    // so replacing this method really is what updateSafe() calls.
    const realPending = w.mh.queue.pending.bind(w.mh.queue);
    w.mh.queue.pending = () => [{ id: "stuck-1", attempts: 47, op: "thread", threadKey: "work|1" }];
    check(w.mh.queue.pending().length === 1, "the stuck action is in place for the test");
    // a pending action that cannot drain must DELAY an update, never cancel it
    upd.heldSince = Date.now();
    const blockedNow = w.mh.updateSafe();
    upd.heldSince = Date.now() - 11 * 60_000;      // stuck for longer than the hold
    const allowedLater = w.mh.updateSafe();
    console.log("update gate with a stuck queue: immediately", blockedNow, "| after the hold expires", allowedLater);
    check(blockedNow === false, "a freshly stuck action DELAYS the update (the old code blocked for ever)");
    check(allowedLater === true, "and stops blocking it once the hold expires");
    // unsaved typing must still hold it, however long it has been waiting
    const rt = w.document.querySelector("#rtext"); const wasVal = rt ? rt.value : null;
    if (rt) { rt.value = "half a reply"; check(w.mh.updateSafe() === false, "but unsaved typing still holds the update, however long it has waited"); rt.value = wasVal; }
    w.mh.queue.pending = realPending;
    upd.heldSince = savedHeld;
  }
  { // Inline (cid:) images in GMAIL mail rendered with an empty src, because proxyImages() resolves a cid by the attachment's
    // `url` and the Gmail adapter supplied none. Found on a USPS Informed Delivery digest whose mail-piece scans are all cid parts.
    const check = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); };
    const atts = [{ id: "ATT1", name: "scan.jpg", cid: "<content-123.jpg>", mime: "image/jpeg", msgId: "m1",
                    url: "/api/gmail/att/a%40gmail.com/m1/ATT1?mime=image%2Fjpeg" }];
    const out = w.mh.proxyImages('<p><img src="cid:content-123.jpg"></p>', atts);
    console.log("cid resolved to:", (out.match(/src="([^"]*)"/) || [])[1]);
    check(/\/api\/gmail\/att\//.test(out), `a cid: image resolves to the attachment's URL — ${out.slice(0, 90)}`);
    check(!/src=""/.test(out), "and never to an empty src, which is what made USPS scans invisible");
    const missing = w.mh.proxyImages('<p><img src="cid:nope.jpg"></p>', atts);
    check(/src=""/.test(missing) || !/nope\.jpg/.test(missing), "a cid with no matching attachment still resolves to nothing rather than leaking the raw cid");
  }
  console.log("perf rows:", w.mh.perf.report().rows.length, "net calls:", w.mh.perf.report().net.calls);
  // ---- push-stash adoption: mail that arrived while the app was CLOSED must be in the list with no network ----
  // Field report: on mobile, new mail still had to load when the app was opened.
  // The service worker downloads the whole conversation at push time and stashes it under meta `pf:`. Before this,
  // only pushedThread() could read that stash and it needs a thread ROW to already exist, so a brand-new
  // conversation had no row until refresh() finished a network sync (895 ms on the phone). Adoption derives the row
  // from bytes already on the device, using the page's OWN adapter so there is exactly one projection.
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const acct = "sam.owner.sxsw@gmail.com", tid = "stash-thread-1";
    const hdr = (name, value) => ({ name, value });
    const raw = { id: tid, messages: [{ id: "sm1", threadId: tid, labelIds: ["INBOX", "UNREAD"], snippet: "the body the worker already fetched",
      internalDate: String(Date.now()), payload: { headers: [hdr("From", "Ada Lovelace <ada@example.com>"), hdr("To", acct),
        hdr("Subject", "Arrived while the app was closed"), hdr("Message-ID", "<stash-1@example.com>"), hdr("Date", new Date().toUTCString())] } }] };
    const key = `${acct}|${tid}`;
    chk(!w.mh.state.threads.has(key), "the conversation is NOT in the list to begin with");
    // exactly what sw.js writes: raw payload under pf:<key>, nothing derived
    await w.mh.idb.meta("pf:" + key, { kind: "gmail", account: acct, id: tid, raw, at: Date.now() });
    const before = w.mh.perf.report().net.calls;
    const res = await w.mh.adoptPushStashes();
    const after = w.mh.perf.report().net.calls;
    chk(res.found >= 1 && res.adopted === 1, `adoption found ${res.found} stash(es) and adopted ${res.adopted}`);
    chk(after === before, `and made ZERO network calls doing it (${after - before})`);
    const t = w.mh.state.threads.get(key);
    chk(!!t, "the conversation is now in the list");
    chk(t && t.subject === "Arrived while the app was closed" && t.unread === true && t.state === "inbox",
      `with the right row derived by the page's own adapter (${t ? `${t.subject} | unread=${t.unread} | ${t.state}` : "MISSING"})`);
    chk(t && t.fromAddr === "ada@example.com", `and the sender resolved (${t && t.fromAddr})`);
    const persisted = await w.mh.idb.get("threads", key);
    chk(!!persisted, "and it is persisted, so the NEXT cold boot has it too");
    const stashStill = await w.mh.idb.meta("pf:" + key);
    chk(!!stashStill, "the stash itself survives adoption, so opening the conversation still renders from local bytes");
    // a second adoption pass must be idempotent, not a duplicate or a resurrection
    const sizeBefore = w.mh.state.threads.size;
    await w.mh.adoptPushStashes();
    chk(w.mh.state.threads.size === sizeBefore, `re-adopting adds no row (${sizeBefore} -> ${w.mh.state.threads.size})`);
    // and a local action the device has not sent yet is the NEWER truth: adoption must not undo it
    w.mh.state.threads.get(key).state = "archived";
    w.mh.state.threads.get(key).updatedAt = Date.now() + 5000;
    await w.mh.adoptPushStashes();
    chk(w.mh.state.threads.get(key).state === "archived",
      `a row newer than its stash is not moved backwards by adoption (${w.mh.state.threads.get(key).state})`);
    // ---- hub/imap adoption: four adversarial lanes called this path "dead on arrival" via a double-parse throw ----
    // /api/threads/:id answers {thread, messages} with to_addrs ALREADY parsed into an array, while hub.norm() does
    // JSON.parse(l.to_addrs). The claim was that this throws out of rowFromStash and is swallowed, making non-Gmail
    // mail silently unsupported. Settled here by running it rather than reading it.
    {
      const tid = "11111111-2222-3333-4444-555555555555";
      const hkey = `hub|${tid}`;
      const hraw = { thread: { id: tid, state: "inbox", unread: 1, starred: 0, labels: '["inbox"]', category: "personal",
                               message_count: 1, last_message_at: new Date().toISOString() },
        messages: [{ id: "hm1", thread_id: tid, direction: "in", identity: "sam@domain2.example",
          from_addr: "grace@example.com", from_name: "Grace Hopper", subject: "Hub mail while closed",
          snippet: "a domain message", message_id: "<hub-1@example.com>",
          to_addrs: [{ address: "sam@domain2.example" }], cc_addrs: [], labels: '[]',
          created_at: new Date().toISOString() }] };
      chk(!w.mh.state.threads.has(hkey), "the hub conversation is not in the list to begin with");
      await w.mh.idb.meta("pf:" + hkey, { kind: "hub", account: "hub", id: tid, raw: hraw, at: Date.now() });
      const hr = await w.mh.adoptPushStashes();
      const ht = w.mh.state.threads.get(hkey);
      chk(!!ht, `hub/imap adoption is NOT dead on arrival — the row is derived (adopted ${hr.adopted})`);
      chk(ht && ht.subject === "Hub mail while closed" && ht.unread === true && ht.state === "inbox",
        `and is correct (${ht ? `${ht.subject} | unread=${ht.unread} | ${ht.state}` : "MISSING"})`);
      chk(ht && ht.fromAddr === "grace@example.com", `with the sender resolved (${ht && ht.fromAddr})`);
      chk(ht && ht.to === "", "the pre-parsed to_addrs degrades to an empty string inside hub.norm's own catch, rather than throwing the row away");
      chk(w.mh.state.hubMsgIds.has("hub-1@example.com"), "and the adopted hub row enters the Gmail-copy dedupe set, so its Gmail twin stays hidden");
    }
    // a non-inbox stash is not adopted at all: norm() resolves archived-vs-snoozed from state that boot has not loaded
    {
      const akey = `${acct}|archived-thread`;
      const araw = { id: "archived-thread", messages: [{ id: "am1", threadId: "archived-thread", labelIds: [], snippet: "x",
        internalDate: String(Date.now()), payload: { headers: [hdr("From", "a@b.c"), hdr("Subject", "archived")] } }] };
      await w.mh.idb.meta("pf:" + akey, { kind: "gmail", account: acct, id: "archived-thread", raw: araw, at: Date.now() });
      await w.mh.adoptPushStashes();
      chk(!w.mh.state.threads.has(akey), "a stash that does not derive to the inbox is refused, so snooze state loadAccounts has not filled cannot be persisted wrong");
    }
    // an expired stash is dropped, never adopted
    const oldKey = `${acct}|stash-expired`;
    await w.mh.idb.meta("pf:" + oldKey, { kind: "gmail", account: acct, id: "stash-expired", raw, at: Date.now() - 25 * 3600e3 });
    const r3 = await w.mh.adoptPushStashes();
    chk(!w.mh.state.threads.has(oldKey), `a stash older than PUSHED_MAX_AGE is not adopted (adopted ${r3.adopted})`);
    chk(!(await w.mh.idb.meta("pf:" + oldKey)), "and is swept away");
  }
  // ---- A conversation reads newest first ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const key = "hub|33333333-3333-3333-3333-333333333333";   // fixture: Perry's question (older), then Sam's reply (newer)
    w.mh.prerendered.delete(key);
    await w.mh.openThread(key); await sleep(150);
    const ms = [...doc.querySelectorAll("#msgs .m")];
    chk(ms.length === 2 && /Please quote 50 pieces/.test(ms[0].textContent) && /Confirming the PN-12028/.test(ms[1].textContent),
      `the newest message is first in the conversation (${ms.map((m) => (m.textContent.match(/Please quote|Confirming/) || ["?"])[0]).join(" / ")})`);
    chk(doc.querySelector("#msgs").scrollTop === 0, "and the conversation opens at the top, where the newest message is");
    const c = (i, n) => w.eval(`messageHtml({ from: "a", to: "b", date: 0, text: "x" }, ${i}, ${n})`).includes('class="m collapsed"');
    chk(!c(0, 5) && !c(1, 5) && !c(2, 5) && c(3, 5) && c(4, 5) && !c(0, 1) && !c(2, 3), "the three newest messages are open and only older ones collapse");
    // a collapsed message previews its OWN words, not the conversation quoted beneath them
    const pv = (m) => w.eval(`messagePreview(${JSON.stringify(m)})`);
    chk(pv({ text: "Sounds good, Tuesday works.\n\nOn Tue, Oct 1, 2026 at 3:21 PM Perry <p@x.example> wrote:\n> Can we meet Tuesday?\n> Thanks" }) === "Sounds good, Tuesday works.", `a plain reply previews its own words (${pv({ text: "Sounds good, Tuesday works.\n\nOn Tue, Oct 1, 2026 at 3:21 PM Perry <p@x.example> wrote:\n> Can we meet Tuesday?" })})`);
    chk(pv({ text: "See attached.\nOn Tue, Oct 1, 2026 at 3:21 PM Perry <\np@x.example> wrote:\n> old" }).startsWith("See attached.") && !/old/.test(pv({ text: "See attached.\nOn Tue, Oct 1, 2026 at 3:21 PM Perry <\np@x.example> wrote:\n> old" })), "a wrapped 'On … wrote:' still ends the preview");
    chk(pv({ text: "", html: "<style>p{color:red}</style><div>Hi Sam,<br>the quote is <b>attached</b> &amp; valid.</div><div class=\"gmail_quote\">On Mon … wrote:<blockquote>old text</blockquote></div>" }) === "Hi Sam, the quote is attached & valid.",
      `an HTML-only reply previews its text without styles, tags or the quote (${pv({ text: "", html: "<style>p{color:red}</style><div>Hi Sam,<br>the quote is <b>attached</b> &amp; valid.</div><div class=\"gmail_quote\">On Mon … wrote:<blockquote>old text</blockquote></div>" })})`);
    // a long conversation: three open, previews on the rest, and "Expand all" opens everything
    {
      const lkey = "hub|88888888-1111-2222-3333-444444444444";
      const msgs = [1, 2, 3, 4, 5].map((k) => ({ id: "lm" + k, from: k % 2 ? "Acme <team@acme.example>" : "You", to: "x", date: Date.now() - (6 - k) * 3600e3, text: `Message number ${k} of five.\n\nOn earlier, someone wrote:\n> quoted ${k - 1}`, attachments: [] }));
      w.mh.state.threads.set(lkey, { key: lkey, account: "hub", kind: "hub", id: "88888888-1111-2222-3333-444444444444", subject: "Acme Space", fromAddr: "team@acme.example", state: "inbox", unread: false, count: 5, date: Date.now(), updatedAt: Date.now() });
      w.__pt = w.mh.state.threads.get(lkey); w.__pd = { thread: { id: "8888" }, messages: msgs }; w.eval("prerender(window.__pt, window.__pd)");
      await w.mh.openThread(lkey); await sleep(150);
      const els = [...doc.querySelectorAll("#msgs .m")];
      chk(els.length === 5 && /number 5/.test(els[0].textContent) && /number 1/.test(els[4].textContent), "a five-message conversation reads newest first");
      chk(els.slice(0, 3).every((e) => !e.classList.contains("collapsed")) && els.slice(3).every((e) => e.classList.contains("collapsed")), "the three newest are open, the two oldest collapsed");
      chk(els[3].querySelector(".pv")?.textContent === "Message number 2 of five." && !els[0].querySelector(".pv"), `collapsed messages carry a one-line preview of their own words (${els[3].querySelector(".pv")?.textContent})`);
      const btn = doc.querySelector("#msgs .expall");
      chk(!!btn && /Expand all 5 messages/.test(btn.textContent), "an Expand all button sits above a conversation with collapsed messages");
      btn.click();
      chk(!doc.querySelector("#msgs .m.collapsed") && !doc.querySelector("#msgs .expall"), "and pressing it opens every message and goes away");
      w.mh.state.threads.delete(lkey); w.mh.prerendered.delete(lkey);
    }
  }
  // ---- A conversation the user started is Sent, not Archive; and search is newest first ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const row = w.mh.hub.norm({ id: "77777777-1111-2222-3333-444444444444", state: "archived", unread: 0, starred: 0, labels: "[]", message_count: 1, last_message_at: new Date().toISOString(), has_in: 0,
      last: { id: "s1", direction: "out", from_addr: "sam@yourdomain.example", identity: "sam@yourdomain.example", subject: "MKDS rating?", snippet: "s", created_at: new Date().toISOString(), message_id: "<s1@yourdomain.example>", to_addrs: '[{"address":"us-info@partsupply.example"}]' } });
    chk(row.sentOnly === true && row.out === true, `hub.norm reads has_in: 0 as a sent-only conversation (sentOnly ${row.sentOnly})`);
    w.mh.state.threads.set(row.key, row);
    w.mh.setView("archived"); const inArchive = w.mh.visibleThreads().some((t) => t.key === row.key);
    w.mh.setView("sent"); const inSent = w.mh.visibleThreads().some((t) => t.key === row.key);
    w.mh.setView("inbox"); const inInbox = w.mh.visibleThreads().some((t) => t.key === row.key);
    chk(!inArchive && inSent && !inInbox, `a sent-only conversation shows under Sent only (archive ${inArchive}, sent ${inSent}, inbox ${inInbox})`);
    const replied = w.mh.hub.norm({ id: "77777777-1111-2222-3333-444444444444", state: "archived", unread: 0, starred: 0, labels: "[]", message_count: 2, last_message_at: new Date().toISOString(), has_in: 1,
      last: { id: "s2", direction: "out", from_addr: "sam@yourdomain.example", identity: "sam@yourdomain.example", subject: "Re: MKDS rating?", snippet: "s", created_at: new Date().toISOString(), message_id: "<s2@yourdomain.example>", to_addrs: "[]" } });
    Object.assign(w.mh.state.threads.get(row.key), replied);
    w.mh.setView("archived");
    chk(w.mh.visibleThreads().some((t) => t.key === row.key), "once they have written back, an archived conversation is in Archive again, even when you replied last");
    w.mh.state.threads.delete(row.key); w.mh.setView("inbox");

    // search: a more RELEVANT older hit must not sit above a newer one, and a server-only hit slots in by date too
    const all = [...w.mh.state.threads.values()].filter((t) => t.state !== "trash" && t.state !== "spam" && !w.mh.isHubCopy(t)).sort((a, b) => a.date - b.date);
    const older = all[0], newer = all[all.length - 1];
    w.mh.state.search = "zzqq"; w.mh.state.searchHits = new Map([[older.key, { key: older.key, score: -50 }], [newer.key, { key: newer.key, score: -1 }]]);
    const server = { ...newer, key: "sam.owner.sxsw@gmail.com|srv-mid", id: "srv-mid", date: Math.round((older.date + newer.date) / 2), _server: true };
    w.mh.state.serverSearch = new Map([[server.key, server]]); w.mh.state.serverHitKeys = new Set([server.key]);
    const order = w.mh.visibleThreads().map((t) => t.key);
    chk(order.indexOf(newer.key) < order.indexOf(server.key) && order.indexOf(server.key) < order.indexOf(older.key),
      `search results are newest first whatever their relevance or source (${[newer, server, older].map((t) => order.indexOf(t.key)).join(" < ")})`);
    w.mh.state.search = ""; w.mh.state.searchHits = null; w.mh.state.serverSearch = new Map(); w.mh.state.serverHitKeys = null;
  }
  // ---- New mail should be waiting on open, not loading ----
  // Most reopens of an installed PWA on Android are RESUMES, not boots, and adoption used to run only at boot. A stash the worker
  // wrote while the app was in the background must reach the list on the return to the foreground, before any network answers.
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const acct = "sam.owner.sxsw@gmail.com", tid = "resume-thread-1", key = `${acct}|${tid}`;
    const hdr = (name, value) => ({ name, value });
    const raw = { id: tid, messages: [{ id: "rm1", threadId: tid, labelIds: ["INBOX", "UNREAD"], snippet: "arrived while the app was in the background",
      internalDate: String(Date.now()), payload: { headers: [hdr("From", "Rosa Park <rosa@example.com>"), hdr("To", acct),
        hdr("Subject", "Arrived while backgrounded"), hdr("Message-ID", "<resume-1@example.com>"), hdr("Date", new Date().toUTCString())] } }] };
    w.mh.setView("inbox");
    chk(!w.mh.state.threads.has(key), "resume: the conversation is not in the list before the app comes back");
    await w.mh.idb.meta("pf:" + key, { kind: "gmail", account: acct, id: tid, raw, at: Date.now() });
    const b0 = w.mh.perf.boot.resumes || 0, a0 = w.mh.perf.boot.resumeAdopted || 0;
    // Hold every network call, so the ONLY way the row can appear is from bytes already on the device.
    const realFetch = w.fetch; let release; const gate = new Promise((r) => { release = r; }); let held = 0;
    w.fetch = async (...a) => { held++; await gate; return realFetch(...a); };
    Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
    w.document.dispatchEvent(new w.Event("visibilitychange", { bubbles: true }));
    await sleep(150);
    chk(w.mh.state.threads.has(key) && w.mh.state.threads.get(key).subject === "Arrived while backgrounded", "resume: the stash is adopted on the return to the foreground");
    chk(!!doc.querySelector(`#threads .t[data-key="${key}"]`), `resume: and it is painted while the network is still held (${held} call(s) waiting)`);
    chk((w.mh.perf.boot.resumes || 0) === b0 + 1 && (w.mh.perf.boot.resumeAdopted || 0) === a0 + 1, "resume: the Speed panel's resume census counts it");
    w.fetch = realFetch; release();
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
  }
  // A hub row a sync wrote AFTER the push holds the newer truth; a just-adopted message must not open
  // from a prerender cached before it.
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const tid = "99999999-2222-3333-4444-555555555555", hkey = `hub|${tid}`, pushAt = Date.now() - 30000;
    const hraw = { thread: { id: tid, state: "inbox", unread: 1, starred: 0, labels: '["inbox"]', category: "personal", message_count: 1, last_message_at: new Date(pushAt).toISOString() },
      messages: [{ id: "hm9", thread_id: tid, direction: "in", identity: "sam@domain2.example", from_addr: "ivy@example.com", from_name: "Ivy", subject: "Archived elsewhere",
        snippet: "s", message_id: "<hub-9@example.com>", to_addrs: [], cc_addrs: [], labels: "[]", created_at: new Date(pushAt).toISOString() }] };
    // the hub sync already applied an archive done on another device, AFTER this push was stashed
    w.mh.state.threads.set(hkey, { ...w.mh.hub.norm({ ...hraw.thread, last: hraw.messages[0], msg_ids: ["<hub-9@example.com>"] }), state: "archived", unread: false, syncedAt: Date.now() });
    await w.mh.idb.meta("pf:" + hkey, { kind: "hub", account: "hub", id: tid, raw: hraw, at: pushAt });
    await w.mh.adoptPushStashes();
    chk(w.mh.state.threads.get(hkey).state === "archived", `adoption guard: a hub row synced after the push is not moved back to the inbox (${w.mh.state.threads.get(hkey).state})`);
    w.mh.state.threads.get(hkey).syncedAt = pushAt - 60000;   // the same row, but last synced BEFORE the push: the push is the newer truth
    await w.mh.adoptPushStashes();
    chk(w.mh.state.threads.get(hkey).state === "inbox", `adoption guard: and one synced before the push is adopted as before (${w.mh.state.threads.get(hkey).state})`);
    await w.mh.idb.del("meta", "pf:" + hkey);

    // a prerender cached before the pushed message must be dropped on the resume that adopts it
    const acct = "sam.owner.sxsw@gmail.com", gtid = "resume-thread-2", gkey = `${acct}|${gtid}`; const hdr = (name, value) => ({ name, value });
    w.mh.state.threads.set(gkey, { key: gkey, account: acct, kind: "gmail", id: gtid, subject: "Old", fromAddr: "old@example.com", state: "inbox", unread: false, count: 1, date: Date.now() - 864e5, updatedAt: 1 });
    w.mh.prerendered.set(gkey, { html: "<div>old</div>", d: { messages: [{ id: "old1" }] }, at: Date.now() - 100000 });
    await w.mh.idb.meta("pf:" + gkey, { kind: "gmail", account: acct, id: gtid, at: Date.now(), raw: { id: gtid, messages: [
      { id: "old1", threadId: gtid, labelIds: ["INBOX"], internalDate: String(Date.now() - 864e5), snippet: "o", payload: { headers: [hdr("From", "old@example.com"), hdr("Subject", "Old")] } },
      { id: "new1", threadId: gtid, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.now()), snippet: "n", payload: { headers: [hdr("From", "Old Friend <old@example.com>"), hdr("Subject", "Re: Old")] } }] } });
    const realFetch = w.fetch; let release; const gate = new Promise((r) => { release = r; });
    w.fetch = async (...a) => { await gate; return realFetch(...a); };
    w.document.dispatchEvent(new w.Event("visibilitychange", { bubbles: true }));
    await sleep(150);
    chk(w.mh.state.threads.get(gkey).count === 2 && !w.mh.prerendered.has(gkey), `resume: the adopted reply drops the prerender cached before it, so a tap cannot open the old copy (count ${w.mh.state.threads.get(gkey).count}, prerender ${w.mh.prerendered.has(gkey) ? "KEPT" : "dropped"})`);
    w.fetch = realFetch; release();
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
  }
  // New mail is painted when its own account has it, not after the slowest account and the ten-minute reconcile pass. Gmail
  // paints are held for the hub, because a Gmail copy of domain mail is hidden only once the hub row is known.
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const acct = "sam.owner.sxsw@gmail.com"; const hdr = (name, value) => ({ name, value });
    const msg = (id, tid, subj) => ({ id, threadId: tid, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.now()), snippet: "s " + subj,
      payload: { headers: [hdr("From", "Early Bird <early@example.com>"), hdr("To", acct), hdr("Subject", subj), hdr("Date", new Date().toUTCString()), hdr("Message-ID", `<${id}@example.com>`)] } });
    const dueReconcile = async () => { const st = await w.mh.idb.get("state", "state|" + acct); st.reconciledAt = 0; await w.mh.idb.putAll("state", [st]); };
    const realFetch = w.fetch;
    const idle = async () => { for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50); };
    const run = async (id, tid, subj, hubDelayMs) => {
      await idle(); w.mh.setView("inbox"); await sleep(20); await idle();   // setView can start its own refresh; let it finish first
      await dueReconcile();
      const cur = (await w.mh.idb.get("state", "state|" + acct)).historyId;
      w.__mock.routes["GET gmail:history?"] = { history: [{ id: String(Number(cur) + 1), messagesAdded: [{ message: { id, threadId: tid, labelIds: ["INBOX", "UNREAD"] } }] }], historyId: String(Number(cur) + 1) };
      w.__mock.routes[`GET gmail:messages/${id}?`] = msg(id, tid, subj);
      const key = `${acct}|${tid}`; let atReconcile = null;
      w.fetch = async (url, o) => {
        const u = String(url);
        if (u.includes("q=newer_than")) atReconcile = { state: w.mh.state.threads.has(key), painted: !!doc.querySelector(`#threads .t[data-key="${key}"]`) };
        if (hubDelayMs && u.includes("/api/threads?limit=500&since_seq")) await sleep(hubDelayMs);
        return realFetch(url, o);
      };
      const c0 = calls.length;
      await w.mh.refresh({ silent: true });
      w.fetch = realFetch;
      if (calls.length === c0) errors.push("ASSERT early paint harness: refresh() made no calls — another refresh held state.loading");
      return { atReconcile, paintedAfter: !!doc.querySelector(`#threads .t[data-key="${key}"]`) };
    };
    const n0 = w.mh.perf.stats["refresh:first-paint"]?.n || 0;
    const fast = await run("gmearly1", "gearly1", "Painted before the reconcile", 0);
    chk(!!fast.atReconcile, "early paint: the reconcile pass ran in this refresh (it is due on almost every reopen)");
    chk(fast.atReconcile && fast.atReconcile.state && fast.atReconcile.painted, `early paint: a message history delivered is ON SCREEN before the reconcile round trip starts (${JSON.stringify(fast.atReconcile)})`);
    chk((w.mh.perf.stats["refresh:first-paint"]?.n || 0) === n0 + 1, "early paint: refresh:first-paint is recorded for the Speed panel");
    const slowHub = await run("gmearly2", "gearly2", "Held for the hub", 400);
    chk(slowHub.atReconcile && slowHub.atReconcile.state && !slowHub.atReconcile.painted, `early paint: while the hub has not answered, a Gmail paint is HELD so a Gmail copy of domain mail cannot flash up (${JSON.stringify(slowHub.atReconcile)})`);
    chk(slowHub.paintedAfter, "early paint: and the held mail is on screen once the refresh completes");
    w.__mock.routes["GET gmail:history?"] = { history: [], historyId: (await w.mh.idb.get("state", "state|" + acct)).historyId };
  }
  // The row's fourth button is Unsubscribe on EVERY received conversation . It used to be Block, shown only for
  // senders still awaiting screening, so it vanished from any sender that had been accepted.
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    w.mh.setView("inbox"); w.mh.render(); await sleep(50);
    const rowEls = [...doc.querySelectorAll("#threads .t")].filter((d) => w.mh.state.threads.has(d.dataset.key));
    const inbound = rowEls.filter((d) => !w.mh.state.threads.get(d.dataset.key).out), outbound = rowEls.filter((d) => w.mh.state.threads.get(d.dataset.key).out);
    const accepted = inbound.filter((d) => !w.mh.state.pendingSenders.has(w.mh.state.threads.get(d.dataset.key).fromAddr));
    chk(inbound.length >= 3 && inbound.every((d) => d.querySelector('.quick [data-q="unsubscribe"]')), `unsub button: every received conversation has it (${inbound.filter((d) => d.querySelector('.quick [data-q="unsubscribe"]')).length}/${inbound.length})`);
    chk(accepted.length >= 1 && accepted.every((d) => d.querySelector('.quick [data-q="unsubscribe"]')), `unsub button: including senders already accepted, where Block used to vanish (${accepted.length} row(s))`);
    chk(!rowEls.some((d) => d.querySelector('.quick [data-q="block"]')), "unsub button: no row carries the old Block quick button");
    { // the fixture's own outbound thread is not in this view, so make one: a row whose last message is yours
      const probe = w.mh.state.threads.get(inbound[0].dataset.key); probe.out = true; w.mh.render(); await sleep(30);
      const el = doc.querySelector(`#threads .t[data-key="${probe.key}"]`);
      chk(!!el && !el.querySelector('.quick [data-q="unsubscribe"]'), `unsub button: a conversation whose last message is yours has none (${outbound.length + 1} such row(s))`);
      probe.out = false; w.mh.render(); await sleep(30);
    }
    const askText = () => doc.querySelector("#ask .msg")?.textContent || "", askOk = () => doc.querySelector("#ask .btns button:last-child"), askCancel = () => doc.querySelector("#ask .btns button:first-child");
    // no header at all: the button offers Block, named as Block
    const bare = w.mh.state.threads.get("hub|11111111-1111-1111-1111-111111111111"); bare.unsub = ""; bare.unsubKnown = true;
    let p = w.mh.act(bare, "unsubscribe"); await sleep(30);
    chk(/has no unsubscribe link/.test(askText()) && askOk()?.textContent === "Block sender", `unsub: mail with no unsubscribe link offers Block sender instead (${JSON.stringify(askText().slice(0, 60))} / ${askOk()?.textContent})`);
    askCancel().click(); await p;
    const c0 = calls.length; p = w.mh.act(bare, "unsubscribe"); await sleep(30); askOk().click(); await p; await sleep(50);
    chk(calls.slice(c0).includes("POST /api/senders") && /Blocked bob@example.com/.test(doc.querySelector("#toast").textContent), `unsub: confirming it blocks the sender and says so (${doc.querySelector("#toast").textContent})`);
    // One tap: no card; the conversation is trashed here and a job for the hub waits 5 s in the queue. These pull the
    // job back out and put the row back, so later checks see the list as it was.
    const askOn = () => !!doc.querySelector("#ask")?.classList.contains("on");
    const unsubRow = (sender) => w.mh.queue.pending().find((r) => r.op === "unsub" && r.args?.sender === sender);
    const takeBack = async (row) => { const j = unsubRow(row.fromAddr); if (j) await w.mh.queue.remove(j.key); row.state = "inbox"; };
    // a Gmail row whose header was never captured learns it on the spot, then unsubscribes
    const g1 = w.mh.state.threads.get("sam.owner.sxsw@gmail.com|g1");
    if (g1) {
      g1.unsub = ""; g1.unsubKnown = false;
      // a row is "unknown" only when its records predate header capture: the field is ABSENT from them, not empty
      const rec = await w.mh.idb.get("messages", "sam.owner.sxsw@gmail.com|gm1"); if (rec) { delete rec.unsub; delete rec.unsubPost; await w.mh.idb.putAll("messages", [rec]); }
      chk(!!rec, "unsub: the Gmail fixture's message record exists to be learned from");
      const saved = w.__mock.routes["GET gmail:messages/gm1?"];
      w.__mock.routes["GET gmail:messages/gm1?"] = { ...saved, payload: { headers: [...(saved.payload.headers || []), { name: "List-Unsubscribe", value: "<mailto:leave@list.example?subject=unsubscribe>" }] } };
      const c0 = calls.length; p = w.mh.act(g1, "unsubscribe"); await p; await sleep(60);
      const j = unsubRow("alice@example.com");
      chk(calls.slice(c0).filter((c) => c.startsWith("GET gmail:messages/gm1?")).length === 1 && !askOn() && !!j && g1.state === "trash", `unsub: an uncaptured Gmail header is learned with one get, then it unsubscribes with no card (card ${askOn()}, job ${!!j}, ${g1.state})`);
      chk(j && j.notBefore - Date.now() > 3000 && j.args.thread === "g1" && j.args.account === "sam.owner.sxsw@gmail.com" && !("url" in j.args), `unsub: the job waits out the 5 s Undo and names the conversation, not a link (${JSON.stringify(j?.args)})`);
      await takeBack(g1); w.__mock.routes["GET gmail:messages/gm1?"] = saved;
    } else chk(false, "unsub: Gmail fixture g1 missing");
    // no local records at all (a push-adopted row, a search hit): "no unsubscribe link" may only be said after looking
    {
      const acct = "sam.owner.sxsw@gmail.com", key = `${acct}|gnorec`; const hdr = (name, value) => ({ name, value });
      const row = { key, account: acct, kind: "gmail", id: "gnorec", subject: "Deals", fromAddr: "promo@shop.example", fromName: "Shop", state: "inbox", unread: true, count: 1, date: Date.now(), unsub: "", unsubKnown: false };
      w.mh.state.threads.set(key, row);
      w.__mock.routes["GET gmail:threads/gnorec?"] = { id: "gnorec", messages: [{ id: "gnr1", threadId: "gnorec", labelIds: ["INBOX"], internalDate: String(Date.now()), snippet: "d",
        payload: { mimeType: "text/plain", headers: [hdr("From", "Shop <promo@shop.example>"), hdr("To", acct), hdr("Subject", "Deals"), hdr("List-Unsubscribe", "<https://shop.example/u?x=1>"), hdr("List-Unsubscribe-Post", "List-Unsubscribe=One-Click")] } }] };
      const c0 = calls.length; await w.mh.act(row, "unsubscribe"); await sleep(80);
      chk(calls.slice(c0).some((c) => c.startsWith("GET gmail:threads/gnorec?")) && !askOn() && !!unsubRow("promo@shop.example"),
        `unsub: with no local records the conversation is read before anything is claimed, then it unsubscribes (card ${askOn()}, job ${!!unsubRow("promo@shop.example")})`);
      await takeBack(row); w.mh.state.threads.delete(key);
    }
    // The device never contacts the list itself any more: the hub reads the headers and sends the one-click. The
    // device's own DNS filtering (A blocked tracker host) can no longer stop it, and the list's answer is recorded.
    {
      const acct = "sam.owner.sxsw@gmail.com"; const realFetch = w.fetch; const listCalls = [];
      const LINK = "https://e.lists.example/unsubscribe/abc?x=1"; const key = `${acct}|gunsub1`;
      const row = { key, account: acct, kind: "gmail", id: "gunsub1", subject: "Fall drinks", fromAddr: "hello@donut.example", fromName: "Donut", state: "inbox", unread: true, count: 1, date: Date.now(), unsub: `<${LINK}>`, unsubPost: "List-Unsubscribe=One-Click", unsubKnown: true };
      w.mh.state.threads.set(key, row); for (const v of ["trash", "modify"]) w.__mock.routes[`POST gmail:threads/gunsub1/${v}`] = {};
      w.fetch = async (url, o = {}) => { if (String(url).startsWith("https://e.lists.example/") || String(url) === "/api/unsubscribe") listCalls.push(String(url)); return realFetch(url, o); };
      const c0 = calls.length; await w.mh.act(row, "unsubscribe"); await sleep(60); w.fetch = realFetch;
      const j = unsubRow("hello@donut.example");
      chk(listCalls.length === 0 && !calls.slice(c0).some((c) => /\/api\/unsubscribe/.test(c)), `unsub one-click: the device sends nothing to the list or to the old endpoint (${JSON.stringify(listCalls)})`);
      chk(!!j && row.state === "trash" && /Unsubscribed from Donut/.test(doc.querySelector("#toast").textContent), `unsub one-click: the conversation is trashed at once and the job waits in the queue (${row.state}, ${doc.querySelector("#toast").textContent})`);
      await takeBack(row); w.mh.state.threads.delete(key); w.mh.render();
    }
    // never your own address
    const mine = w.mh.state.threads.get("hub|33333333-3333-3333-3333-333333333333");
    const c1 = calls.length; await w.mh.act(mine, "unsubscribe"); await sleep(30);
    chk(/last message here is yours/.test(doc.querySelector("#toast").textContent) && !calls.slice(c1).some((c) => /senders|sender-rules/.test(c)), "unsub: a conversation you sent last is never unsubscribed or blocked as YOU");
  }
  // ---- A work mailbox from Settings. The servers are shown before Connect, the request carries what the
  // form shows, and the password leaves the page the moment the hub says OK, or the moment the form is left. ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    w.__mock.routes["GET /api/imap/discover?"] = { host: "mail.corp.example", port: 993, smtp_host: "mail.corp.example", smtp_port: 465, username: "work@corp.example", found: "dns" };
    w.__mock.routes["POST /api/imap/accounts"] = { ok: true, account: { email: "work@corp.example", ready: true, source: "app", host: "mail.corp.example" }, synced: 3 };
    let posted = null; const realFetch = w.fetch; w.fetch = async (u, o = {}) => { if (String(u) === "/api/imap/accounts" && o.method === "POST") posted = JSON.parse(o.body); return realFetch(u, o); };
    await w.mh.openSettings("accounts"); await sleep(50);
    doc.querySelector("#imapAdd").click(); await sleep(20);
    chk(!!doc.querySelector("#imPass") && doc.querySelector("#imPass").type === "password", "work mailbox: Add work account opens the form, with a masked password field");
    const em = doc.querySelector("#imEmail"); em.value = "work@corp.example"; em.dispatchEvent(new w.Event("change")); await sleep(80);
    chk(doc.querySelector("#imHost").value === "mail.corp.example" && /Signs in to mail\.corp\.example/.test(doc.querySelector("#imSrv").textContent), `work mailbox: the servers it will sign in to are shown before Connect (${JSON.stringify(doc.querySelector("#imSrv").textContent)})`);
    doc.querySelector("#imPass").value = "s3cret-xyz"; doc.querySelector("#imGo").click(); await sleep(200);
    chk(posted && posted.email === "work@corp.example" && posted.password === "s3cret-xyz" && posted.host === "mail.corp.example" && posted.smtp_host === "mail.corp.example", `work mailbox: Connect sends exactly what the form shows (${JSON.stringify(posted && { ...posted, password: posted.password ? "<set>" : "" })})`);
    chk(!doc.querySelector("#imPass") && ![...doc.querySelectorAll("#scard input")].some((i) => i.value === "s3cret-xyz"), "work mailbox: after OK the password is gone from the page");
    // half-typed, then Settings closed: the password does not stay behind in the hidden screen
    await w.mh.openSettings("accounts"); await sleep(30); doc.querySelector("#imapAdd").click(); await sleep(20);
    doc.querySelector("#imPass").value = "half-typed-pw"; w.mh.closeSettings(); await sleep(50);
    chk(![...doc.querySelectorAll("input")].some((i) => i.value === "half-typed-pw"), "work mailbox: closing Settings mid-way clears a typed password");
    await w.mh.openSettings("accounts"); await sleep(30); doc.querySelector("#imapAdd").click(); await sleep(20);
    doc.querySelector("#imPass").value = "half-typed-2"; doc.querySelector('#scard [data-sec-nav="general"]').click(); await sleep(30);
    chk(![...doc.querySelectorAll("input")].some((i) => i.value === "half-typed-2"), "work mailbox: moving to another section clears it too");
    w.mh.closeSettings(); w.fetch = realFetch; await sleep(50);
  }
  // ---- An attachment chip downloads under the file's own name (the Northwind PDF saved on the Mac as its attachment id) ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const a = { id: "att1", name: "02 - Oct - Northwind Q3 2026 Update.pdf", size: 99487, mime: "application/pdf", msgId: "ma1", url: "/api/gmail/att/sam%40x.com/ma1/att1?mime=application%2Fpdf" };
    const div = doc.createElement("div");
    const href = w.mh.attHref(a);
    chk(href === "/api/gmail/att/sam%40x.com/ma1/att1?mime=application%2Fpdf&name=02%20-%20Oct%20-%20Northwind%20Q3%202026%20Update.pdf", `the chip asks the hub for the file's own name (${href})`);
    const m = { id: "ma1", from: "Angelclub <u@g.example>", to: "me", date: Date.now(), text: "hi", attachments: [a] };
    div.innerHTML = w.mh.messageHtml(m, 0, 1, []);
    // The chip is a preview button and its own Download button; Download hands the app or browser a same-origin
    // download named for the file, never a link out.
    chk(!!div.querySelector(".atts .attopen") && !!div.querySelector(".atts .attdl") && !div.querySelector(".atts a[href]"), "the chip is a preview button and a Download button, not a link out");
    // Outside the Mac app the page asks the hub for the file's status first (an error answer must not be saved as the file).
    w.__mock.routes["GET /api/gmail/att/sam%40x.com/ma1/att1?mime=application%2Fpdf"] = { __b64: Buffer.from("%PDF-1.4").toString("base64") };
    const clicked = []; const orig = w.HTMLAnchorElement.prototype.click; w.HTMLAnchorElement.prototype.click = function () { clicked.push([this.getAttribute("href"), this.getAttribute("download"), this.getAttribute("target")]); };
    await w.mh.attDownload({ kind: "gmail", account: "sam@x.com" }, a); w.HTMLAnchorElement.prototype.click = orig;
    const link = clicked[0];
    chk(link && link[1] === a.name && !link[2] && link[0] === href, `in a browser or the Mac app, Download is a same-origin download named for the file (${JSON.stringify(link)})`);
  }
  // ---- "real or fake": a banner on a fake, nothing on genuine mail, and the link's domain age filled in ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    w.__mock.routes["GET /api/domain-age?"] = { domain: "jhgbmk.info", registered: "2026-09-07T12:48:50.643Z" };
    const fake = { id: "pf1", from: "Dana Park <dana.park@gmail.com>", fromAddr: "dana.park@gmail.com", to: "undisclosed-recipients:;", subject: "Come to rejoice with me", date: Date.UTC(2026, 8, 14, 20, 3),
      authResults: ["mx.google.com; dkim=pass header.i=@gmail.com; spf=pass; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com"],
      html: '<img src="https://static.punchbowl.com/assets/logos/punchbowl/logo.png" alt="Punchbowl"><h2>You\'re invited!</h2><a href="https://jhgbmk.info/welcometomyparty"><img src="https://static.punchbowl.com/assets/email/invite/btn_open_invitation.png" alt="Open your invitation"></a><p>Optimized for desktop: Please open on a computer.</p>' };
    const genuine = { id: "pf2", from: "Jordan and Casey Lee <info@mailva.evite.com>", fromAddr: "info@mailva.evite.com", to: "sam@x.com", subject: "Pat's birthday", date: Date.now(),
      authResults: ["mx.google.com; dkim=pass header.i=@mailva.evite.com; dmarc=pass (p=REJECT) header.from=mailva.evite.com"], html: '<img src="https://g0.evitecdn.com/a.png"><a href="https://www.evite.com/event/1">View invitation</a>' };
    const div = doc.createElement("div"); doc.body.appendChild(div);
    div.innerHTML = w.mh.messageHtml(fake, 0, 1, []);
    const bar = div.querySelector(".trustbar.danger");
    chk(!!bar && /Probably fake/.test(bar.textContent) && /Punchbowl/.test(bar.textContent) && /jhgbmk\.info/.test(bar.textContent), `the fake Punchbowl shows a "Probably fake" banner naming where its links go (${bar && bar.querySelector("b").textContent})`);
    chk(bar && bar.querySelectorAll("li:not([hidden])").length >= 4, `with its reasons listed (${bar && bar.querySelectorAll("li:not([hidden])").length})`);
    w.mh.fillTrustAges(div); await sleep(80);
    const age = bar && bar.querySelector("li.age");
    chk(age && !age.hidden && /registered 7 days before this message arrived/.test(age.textContent), `and how new that domain is, once on screen (${age && age.textContent})`);
    div.innerHTML = w.mh.messageHtml(genuine, 0, 1, []);
    chk(!div.querySelector(".trustbar"), "a genuine Evite shows nothing at all");
    div.innerHTML = w.mh.messageHtml({ ...fake, out: true }, 0, 1, []);
    chk(!div.querySelector(".trustbar"), "your own sent mail is never assessed");
    const calls0 = calls.length; div.innerHTML = w.mh.messageHtml(genuine, 0, 1, []); w.mh.fillTrustAges(div); await sleep(30);
    chk(!calls.slice(calls0).some((c) => /domain-age/.test(c)), "a message with no banner asks nothing of the network");
    // an impostor: named after a company the user gets mail from (the mock's list has shop.example), from a new domain
    const imp = { id: "im1", from: "Shop <noreply@otherco.example>", fromAddr: "noreply@otherco.example", to: "sam@x.com", subject: "New Login Detected", date: Date.now(), html: "<p>A new sign-in to your Shop account.</p>" };
    chk(calls.some((c) => /\/api\/senders\/orgs/.test(c)), "the app asked the hub once for the domains that have written");
    div.innerHTML = w.mh.messageHtml(imp, 0, 1, []);
    const ib = div.querySelector(".trustbar.danger");
    chk(!!ib && /Named Shop, but it wasn't sent by Shop\./.test(ib.textContent) && /shop\.example/.test(ib.textContent) && /Nobody at otherco\.example has written to you before/.test(ib.textContent), `an impostor shows "Probably fake — Named Shop…" with where Shop's mail comes from (${ib && ib.textContent})`);
    div.innerHTML = w.mh.messageHtml({ ...imp, from: "Shop <noreply@shop.example>", fromAddr: "noreply@shop.example" }, 0, 1, []);
    chk(!div.querySelector(".trustbar"), "the company's own mail shows nothing");
    div.remove();
  }
  // ---- A conversation with no messages has nobody to reply to. The reply box used to appear holding the PREVIOUS
  // conversation's recipient (an empty "(no subject)" shell showed "to sam.mailer@gmail.com"). ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const EID = "99999999-9999-4999-8999-999999999999";
    w.__mock.routes[`GET /api/threads/${EID}`] = { thread: { id: EID, state: "inbox", starred: 0, unread: 0, labels: "[]" }, messages: [] };
    w.mh.state.threads.set("hub|" + EID, { key: "hub|" + EID, account: "hub", kind: "hub", id: EID, subject: "(no subject)", snippet: "", from: "", fromAddr: "", fromName: "", state: "inbox", date: Date.now(), unread: false, count: 1, msgIds: [], labels: [] });
    await w.mh.openThread("hub|11111111-1111-1111-1111-111111111111"); await sleep(150);
    const before = doc.querySelector("#rto").textContent;
    chk(doc.querySelector("#replybox").style.display === "grid" && !!before, `a real conversation shows the reply box, to its sender (${before})`);
    await w.mh.openThread("hub|" + EID); await sleep(150);
    chk(doc.querySelector("#replybox").style.display === "none", `an empty conversation hides the reply box instead of keeping "${before}"`);
    chk(/no messages/.test(doc.querySelector("#msgs").textContent) && w.mh.state.replyTo === null, "and says it has no messages, with nobody to reply to");
    w.mh.state.threads.delete("hub|" + EID);
  }
  // ---- Recipient suggestions under To / Cc / Bcc, from this app's own mail and (when permitted) Google's contacts ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const pl = w.mh.parseAddrList('"Stone, Mike" <Mike.Stone@acoustico.example>, Jordan Hale <Jordan.Hale@acoustico.example>, ccte_api@epa.example');
    chk(pl.length === 3 && pl[0].addr === "mike.stone@acoustico.example" && pl[0].name === "Stone, Mike" && pl[1].name === "Jordan Hale" && pl[2].addr === "ccte_api@epa.example",
      `a To header with a comma inside quotes parses to three people (${JSON.stringify(pl.map((x) => x.addr))})`);
    w.mh.contactBook.list = null; w.mh.contactBook.at = 0; await w.mh.buildContactBook();
    const book = w.mh.contactBook.list.map((c) => c.addr);
    chk(book.includes("robin@family.example") && book.includes("alice@example.com"), "the book holds the hub's people AND the senders of synced Gmail");
    chk(!book.some((a) => /no-?reply/.test(a)) && !book.includes("sam@yourdomain.example"), "no-reply senders and your own addresses are never suggested");
    chk(book.indexOf("robin@family.example") < book.indexOf("robert@old.example"), "someone you write to often and recently outranks an old one-off");
    doc.querySelector("#composeBtn").click(); await sleep(50);
    const to = doc.querySelector("#cto"); const type = async (v) => { to.value = v; to.dispatchEvent(new w.Event("input")); await sleep(40); };
    const sug = () => [...doc.querySelectorAll(".rsug .rs span")].map((x) => x.textContent);
    const c0 = calls.length;
    await type("rob");
    chk(sug()[0] === "robin@family.example" && sug().includes("robert@old.example"), `typing "rob" suggests Robin first (${sug().join(", ")})`);
    await sleep(250);
    chk(!calls.slice(c0).some((c) => /\/v1\/(otherContacts|people)/.test(c)), "without the contacts permission, Google's contact lists are never queried");
    to.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    chk(to.value === "robin@family.example, " && !doc.querySelector(".rsug"), `Enter takes the top suggestion and starts the next address (${JSON.stringify(to.value)})`);
    await type(to.value + "ali");
    chk(sug()[0] === "alice@example.com", `the next address is suggested independently, here from synced Gmail (${sug().join(", ")})`);
    to.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    chk(!doc.querySelector(".rsug") && doc.querySelector("#cmodal").classList.contains("on"), "Escape closes the suggestions, NOT the message being written");
    await type("robin@family.example, rob");
    chk(!sug().includes("robin@family.example"), "an address already in the field is not suggested again");
    // with the read-only contacts permission on the token, Google's lists join in
    const acct = "sam.owner.sxsw@gmail.com"; const tk = w.mh.gmailTokens.get(acct);
    if (tk) tk.scope = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/contacts.other.readonly https://www.googleapis.com/auth/contacts.readonly";
    const c1 = calls.length; await type("di"); await sleep(300);
    const gcalls = calls.slice(c1).filter((c) => /\/v1\/(otherContacts|people)/.test(c));
    chk(!!tk && sug().includes("tom@taxfirm.example") && sug().includes("diane@saved.example") && sug().filter((x) => x === "tom@taxfirm.example").length === 1,
      `with the permission, Google's saved and Other contacts are suggested, once each (${sug().join(", ")})`);
    chk(gcalls.some((c) => /query=&/.test(c)) && gcalls.some((c) => /query=di&/.test(c)), `and Google's warmup query is sent before the first search (${gcalls.length} call(s))`);
    to.value = ""; doc.querySelector(".rsug")?.remove();
  }
  // ---- Tapping a notification for NEW mail while the app was in the background opened nothing ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const acct = "sam.owner.sxsw@gmail.com", tid = "gtapped", key = `${acct}|${tid}`; const hdr = (name, value) => ({ name, value });
    w.__mock.routes["GET gmail:threads/gtapped?"] = { id: tid, messages: [{ id: "gtm1", threadId: tid, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.now()), snippet: "furnace",
      payload: { mimeType: "text/plain", headers: [hdr("From", "Erick <erick@example.com>"), hdr("To", acct), hdr("Subject", "your furnace called"), hdr("Message-ID", "<gt1@example.com>")], body: { data: Buffer.from("It is scared.").toString("base64url") } } }] };
    chk(!w.mh.state.threads.has(key), "the tapped conversation is not on the device");
    // the resume's own sync is still running when the tap lands: hold state.loading for a moment, as visibilitychange does
    w.mh.state.loading = true; setTimeout(() => { w.mh.state.loading = false; }, 400);
    const c0 = calls.length;
    await w.mh.openUrl(`/?account=${encodeURIComponent(acct)}&thread=${tid}`);
    await sleep(200);
    chk(w.mh.state.cur === key, `the notification opens the conversation anyway (current: ${w.mh.state.cur})`);
    chk(calls.slice(c0).some((c) => c.startsWith("GET gmail:threads/gtapped?")), "fetched straight from its account once the syncs had not brought it");
    chk(/your furnace called/.test(doc.querySelector("#vtitle")?.textContent || ""), `and it is on screen (${doc.querySelector("#vtitle")?.textContent})`);
  }
  // ---- the true fix: a conversation handed over at notification time is READY; the tap fetches nothing and builds nothing ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const acct = "sam.owner.sxsw@gmail.com", tid = "gprimed", key = `${acct}|${tid}`; const hdr = (name, value) => ({ name, value });
    const raw = { id: tid, messages: [{ id: "gpm1", threadId: tid, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.now()), snippet: "ready",
      payload: { mimeType: "text/plain", headers: [hdr("From", "Rae <rae@example.com>"), hdr("To", acct), hdr("Subject", "Already here"), hdr("Message-ID", "<gp1@example.com>")], body: { data: Buffer.from("Primed body.").toString("base64url") } } }] };
    const n = await w.mh.acceptStash({ kind: "gmail", account: acct, id: tid, raw, at: Date.now() });
    chk(n === 1 && w.mh.state.threads.has(key) && w.mh.prerendered.has(key), `acceptStash adopts the conversation into the list and prerenders it (${n})`);
    const c0 = calls.length, pre0 = (w.mh.perf.stats["open-thread:prerendered"] || { n: 0 }).n;
    await w.mh.openUrl(`/?account=${encodeURIComponent(acct)}&thread=${tid}`);
    await sleep(50);
    chk(w.mh.state.cur === key && /Already here/.test(doc.querySelector("#vtitle")?.textContent || ""), `the tap opens it (${doc.querySelector("#vtitle")?.textContent})`);
    const fetched = calls.slice(c0).filter((c) => c.startsWith("GET ") && /gprimed|gpm1/.test(c));   // marking it read (POST …/modify) is the open itself, not a load
    chk(fetched.length === 0, `without downloading anything (${fetched.join(", ") || "no GET"})`);
    chk((w.mh.perf.stats["open-thread:prerendered"] || { n: 0 }).n === pre0 + 1, "from the prerendered copy, not a fetch or a rebuild");
  }
  // ---- a Gmail conversation is where Gmail's Inbox puts it, and the Gmail copy of domain mail follows its hub conversation ----
  // Venmo and Cash App codes were in Gmail's inbox and nowhere in Sherit (older codes in the same conversation had
  // been deleted, and ANY deleted message made the whole conversation Trash); and deleting one deleted them all.
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && w.mh.state.loading; i++) await sleep(50);
    const acct = "sam.owner.sxsw@gmail.com";
    const mk = (tid, list, mid = (i) => `${tid}m${i}@venmo.com`) => list.map((labels, i) => ({ key: `${acct}|${tid}m${i}`, threadKey: `${acct}|${tid}`, account: acct, id: `${tid}m${i}`, threadId: tid,
      from: "Venmo <venmo@venmo.com>", fromAddr: "venmo@venmo.com", fromName: "Venmo", to: acct, cc: "", subject: "Venmo - Password Reset", date: 1700000000000 + i * 60000, snippet: "code " + i,
      labels, cat: "notifications", msgIdHdr: mid(i), inReplyTo: "", refs: "", hasAtt: false, size: 1, unsub: "", unsubPost: "" }));
    const derive = (tid, list) => w.eval(`deriveGmailThread(${JSON.stringify(acct)}, ${JSON.stringify(tid)}, ${JSON.stringify(mk(tid, list))})`);
    const v = derive("tv", [["IMPORTANT", "TRASH", "CATEGORY_UPDATES"], ["TRASH"], ["TRASH", "UNREAD"], ["IMPORTANT", "INBOX"], ["UNREAD", "INBOX"]]);
    chk(v.state === "inbox" && v.count === 2 && v.unread === true && v.lastMsgId === "tvm4", `Venmo: three codes deleted, two in the inbox -> in the inbox, counted 2 (${v.state}, ${v.count})`);
    chk(JSON.stringify(v.shownIds) === '["tvm3","tvm4"]' && v.msgIds.length === 5, `only the live codes are shown; every Message-ID still feeds the hub-copy check (${v.shownIds}, ${v.msgIds.length})`);
    const c = derive("tc", [["TRASH", "UNREAD"], ["TRASH", "UNREAD"], ["INBOX"]]);
    chk(c.state === "inbox" && c.count === 1 && c.unread === false, `Cash App: deleted unread codes do not make the live one unread (${c.state}, ${c.count}, unread ${c.unread})`);
    const gone = derive("tg", [["TRASH"], ["TRASH", "UNREAD"]]);
    chk(gone.state === "trash" && gone.count === 2 && gone.shownIds === null, `every message deleted -> Trash, with all of them (${gone.state}, ${gone.count})`);
    chk(derive("ta", [["TRASH"], ["CATEGORY_UPDATES"]]).state === "archived", "one deleted and one archived -> archived, not Trash");
    chk(derive("ts", [["SPAM"]]).state === "spam" && derive("ti", [["INBOX"], ["SENT"]]).shownIds === null, "spam stays spam; nothing deleted means nothing hidden");
    const hdr = (name, value) => ({ name, value });
    const gm = (id, labelIds) => ({ id, threadId: "tv", labelIds, internalDate: "1700000000000", payload: { mimeType: "text/plain", headers: [hdr("From", "Venmo <venmo@venmo.com>"), hdr("Subject", "Venmo - Password Reset"), hdr("Message-ID", `<${id}@venmo.com>`)], body: { data: Buffer.from("code " + id).toString("base64url") } } });
    const d = w.eval(`gmailAdapter(${JSON.stringify(acct)})`).normalize({ id: "tv", messages: [gm("tvm0", ["TRASH"]), gm("tvm3", ["INBOX"]), gm("tvm4", ["INBOX", "UNREAD"])] });
    chk(d.messages.map((m) => m.id).join() === "tvm3,tvm4", `opening it shows the live codes, not the deleted one (${d.messages.map((m) => m.id)})`);
    await w.mh.idb.putAll("bodies", ["tvm0", "tvm1", "tvm3", "tvm4"].map((id, i) => ({ key: `${acct}|${id}`, threadKey: `${acct}|tv`, id, date: 1700000000000 + i, at: Date.now(), m: { id, date: 1700000000000 + i, unsub: "", attachments: [] } })));
    const cached = await w.mh.cachedThread({ ...v, unsubKnown: true });
    chk(cached && cached.messages.map((m) => m.id).join() === "tvm3,tvm4", `a body cached while a code was still live does not bring it back (${cached && cached.messages.map((m) => m.id)})`);

    // The copies: hub conversation state on the left, the hidden Gmail copy's labels on the right.
    const S = w.mh.state;
    const plan = { 1: ["trash", false, ["INBOX", "UNREAD"]], 2: ["archived", false, ["INBOX", "UNREAD"]], 3: ["inbox", true, ["INBOX", "UNREAD"]], 4: ["inbox", false, ["INBOX", "UNREAD"]],
                   5: ["trash", false, ["INBOX", "UNREAD"]], 6: ["inbox", false, ["TRASH"]], 7: ["trash", false, ["INBOX"]] };
    const recs = [], keys = [];
    for (const [n, [st, unread, labels]] of Object.entries(plan)) {
      S.threads.set(`hub|h${n}`, { key: `hub|h${n}`, kind: "hub", account: "hub", id: `h${n}`, state: st, unread, starred: false, subject: "copy " + n, msgIdHdr: `h${n}@x`, msgIds: [`h${n}@x`], date: Date.now(), fromAddr: "news@x.example", updatedAt: Date.now() });
      recs.push(...mk(`ct${n}`, [labels], () => `h${n}@x`)); keys.push(`${acct}|ct${n}`); w.__mock.routes[`POST gmail:messages/ct${n}m0/modify`] = {};
    }
    recs.push(...mk("cg", [["INBOX", "UNREAD"]], () => "real@x")); keys.push(`${acct}|cg`); w.__mock.routes["POST gmail:messages/cgm0/modify"] = {};   // genuine Gmail mail, not a copy
    await w.mh.idb.putAll("messages", recs); await w.eval(`rebuildGmailThreads(${JSON.stringify(acct)}, ${JSON.stringify(keys)})`); w.eval("rebuildHubMsgIds()");
    w.mh.queue.recent.set("hub|h5", Date.now());   // an action on h5 is still on its way to the hub
    const sent = {}; const realFetch = w.fetch;
    w.fetch = (u, o = {}) => { const m = /messages\/(\w+)\/modify/.exec(String(u)); if (m) sent[m[1]] = JSON.parse(o.body); return realFetch(u, o); };
    const runMirror = async () => { for (let i = 0; i < 100 && w.eval("mirrorHubCopies.busy"); i++) await sleep(20); await w.mh.mirrorHubCopies(); };
    w.__mock.failNext = { match: /messages\/ct7m0\/modify/, status: 500 };
    await runMirror();
    const body = (n) => JSON.stringify(sent[`ct${n}m0`] || null);
    chk(body(1) === '{"addLabelIds":["TRASH"],"removeLabelIds":["INBOX","UNREAD"]}', `trashed in Sherit -> the Gmail copy goes to Trash, out of the inbox, read (${body(1)})`);
    chk(body(2) === '{"addLabelIds":[],"removeLabelIds":["INBOX","UNREAD"]}', `done in Sherit -> the copy leaves Gmail's inbox, read (${body(2)})`);
    chk(body(4) === '{"addLabelIds":[],"removeLabelIds":["UNREAD"]}', `read in Sherit, still in its inbox -> the copy is marked read and stays put (${body(4)})`);
    chk(!sent.ct3m0 && !sent.ct6m0, "a hub conversation in the inbox never pulls its copy back into Gmail's inbox or out of Gmail's Trash");
    chk(!sent.ct5m0, "a hub conversation with an action still queued is left until the hub has it");
    chk(!sent.cgm0, "genuine Gmail mail is never touched");
    chk(S.threads.get(`${acct}|ct1`).state === "trash" && S.threads.get(`${acct}|ct2`).state === "archived", "the copies' local labels follow, so the next pass has nothing to send");
    const failedFirst = !!sent.ct7m0 && S.threads.get(`${acct}|ct7`).state !== "trash";
    for (const k of Object.keys(sent)) delete sent[k];
    await runMirror();
    chk(failedFirst && body(7) !== "null" && S.threads.get(`${acct}|ct7`).state === "trash", `a Gmail call that failed is simply sent again on the next pass (${body(7)})`);
    chk(Object.keys(sent).join() === "ct7m0", `and nothing already done is sent twice (${Object.keys(sent).join() || "none"})`);
    w.fetch = realFetch;
  }
  // ---- every unread message in a Gmail inbox is on the device, however old (489 of 491 were past the 90-day window) ----
  {
    const chk = (cond, msg) => { if (!cond) errors.push("ASSERT " + msg); console.log((cond ? "ok   " : "FAIL ") + msg); };
    const acct = "sam.owner.sxsw@gmail.com"; const hdr = (name, value) => ({ name, value }); const old = Date.parse("2024-03-01T12:00:00Z");
    const ids = Array.from({ length: 150 }, (_, i) => `ou${i}`);
    w.__mock.routes["GET gmail:messages?maxResults=500&q=in%3Ainbox%20is%3Aunread"] = { messages: ids.map((id) => ({ id, threadId: "ot" + id.slice(2) })), resultSizeEstimate: 150 };
    for (const [i, id] of ids.entries()) w.__mock.routes[`GET gmail:messages/${id}?`] = { id, threadId: "ot" + i, labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES"], internalDate: String(old + i * 86400e3), snippet: "old " + i,
      payload: { mimeType: "text/plain", headers: [hdr("From", `Old Sender ${i} <old${i}@example.com>`), hdr("To", acct), hdr("Subject", `From long ago ${i}`), hdr("Message-ID", `<ou${i}@example.com>`)] } };
    await w.mh.idb.putAll("messages", [{ key: `${acct}|ou0`, threadKey: `${acct}|ot0`, account: acct, id: "ou0", threadId: "ot0", from: "x", fromAddr: "old0@example.com", fromName: "x", to: acct, cc: "", subject: "From long ago 0", date: old, snippet: "", labels: ["INBOX", "UNREAD"], cat: "personal", msgIdHdr: "ou0@example.com", inReplyTo: "", refs: "", hasAtt: false, size: 1, unsub: "", unsubPost: "" }]);
    await w.eval(`rebuildGmailThreads(${JSON.stringify(acct)}, [${JSON.stringify(acct + "|ot0")}])`);   // the one already here has its row, as on a real device
    const c0 = calls.length;
    const r1 = await w.eval(`fillUnread(${JSON.stringify(acct)})`);
    chk(r1.listed === 150 && r1.fetched === 100 && r1.left === 49, `one sync loads a slice of 100 of the 149 missing, never the one already here (${JSON.stringify(r1)})`);
    chk(!calls.slice(c0).some((c) => /messages\/ou0\?/.test(c)), "the unread message already on the device is not fetched again");
    const r2 = await w.eval(`fillUnread(${JSON.stringify(acct)})`);
    chk(r2.fetched === 49 && r2.left === 0, `the next sync finishes the rest (${JSON.stringify(r2)})`);
    const t = w.mh.state.threads.get(`${acct}|ot149`);
    chk(t && t.state === "inbox" && t.unread && /From long ago 149/.test(t.subject), `a two-year-old unread message is in the inbox, unread (${t && t.state}, ${t && t.unread})`);
    const here = [...w.mh.state.threads.values()].filter((x) => x.account === acct && /^ot\d+$/.test(x.id) && x.unread && x.state === "inbox").length;
    chk(here === 150, `all 150 are there, unread in the inbox (${here})`);
    const r3 = await w.eval(`fillUnread(${JSON.stringify(acct)})`);
    chk(r3.fetched === 0 && r3.left === 0, `a re-check with nothing missing fetches nothing (${JSON.stringify(r3)})`);
  }
  console.log("errors:", errors.length); errors.forEach((e) => console.log("  -", e.split("\n").slice(0, 3).join(" | ")));
  process.exit(errors.length ? 1 : 0);
})();
