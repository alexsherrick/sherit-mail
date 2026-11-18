#!/usr/bin/env node
// EXECUTION test for the unsubscribe job: the real Worker, the real migrations in SQLite, a fake R2, the network
// stubbed at globalThis.fetch (Gmail's API, DNS, the lists' servers).
//
// An unsubscribe took 5-15 s on screen, too slow for a list. The app now takes the mail off the screen and,
// 5 s later, tells the hub which conversation and which sender; the hub reads the headers itself, tries one-click (only when a
// passing DKIM signature covers the headers, RFC 8058 section 4), then the list's email address, then its page, and records what
// happened. Then it trashes the sender's other promotions, and the second rule holds: an order from a sender stays even after it
// puts you on its list; only the promotions go. Usage: node test/unsubjob.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

// ---------- the real migrations (statement splitting and comment stripping as test/ingest.mjs does) ----------
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb({ upTo = null, between = null } = {}) {
  const sq = new DatabaseSync(":memory:"); const skipped = [];
  for (const f of readdirSync(HUB + "migrations").sort()) {
    if (upTo && f >= upTo && between) { between(sq); between = null; }
    for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (e) { skipped.push(`${f}: ${String(e.message).slice(0, 70)}`); } }
  }
  return { sq, skipped };
}
const d1 = (sq) => {
  const run = (sql, p, kind) => { const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; } };
};
const r2 = () => { const objs = new Map(); return { _objs: objs, put: async (k, v) => { objs.set(k, Buffer.from(v)); }, get: async (k) => { const b = objs.get(k); return b ? { body: b, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null; }, list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); } }; };

// ---------- the real Worker, with the job's pieces exported for this file ----------
const SRC = readFileSync(process.env.UNSUBJOB_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";')
  + "\nexport { unsubCron as __unsubCron, matchSender as __matchSender, dkimCovers as __dkimCovers, UNSUB_TXN as __UNSUB_TXN, gmailTokenCache as __tokens, unsubForm as __unsubForm, unsubNoteArrival as __noteArrival, unsubJobsLoader as __jobsLoader, businessDaysAfter as __bdays };\n";
const tmp = `${HUB}test/_unsubjob_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

// ---------- the network ----------
let sent = [], routes = [];
const PRIVATE = new Set(["sneaky.example"]);
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") { const name = u.searchParams.get("name"), type = u.searchParams.get("type"); const data = PRIVATE.has(name) ? (type === "A" ? "127.0.0.1" : "::1") : (type === "A" ? "35.244.218.227" : null); return new Response(JSON.stringify({ Answer: data ? [{ type: type === "A" ? 1 : 28, data }] : [] })); }
  const rec = { url: u.href, path: u.pathname + u.search, method: init.method || "GET", body: init.body, headers: new Headers(init.headers || {}), redirect: init.redirect }; sent.push(rec);
  for (const [test, answer] of routes) if (test(u, rec)) return answer(u, rec);
  return new Response(JSON.stringify({ error: { message: "no route in the test" } }), { status: 404 });
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const gmail = (u, p) => u.hostname === "gmail.googleapis.com" && (u.pathname + u.search).startsWith("/gmail/v1/users/me/" + p);

// ---------- fixtures: header shapes read from the user's Gmail, 2026-10-21 (DoorDash; another sender's signature lacks the Post header) ----------
const AR_DD = 'mx.google.com; dkim=pass header.i=@c.doordash.com header.s=s1 header.b="mrOT7rO/"; dkim=pass header.i=@sendgrid.info header.s=smtpapi header.b=fQ0bt2ty; spf=pass smtp.mailfrom=bounces@bounce.c.doordash.com; dmarc=pass (p=REJECT) header.from=doordash.com';
const SIG = (b, h) => `v=1; a=rsa-sha256; c=relaxed/relaxed; d=c.doordash.com;\r\n h=${h}; s=s1;\r\n bh=AbCdEfGh0123456789=; b=${b}AAAABBBBCCCCDDDD\r\n EEEEFFFF==`;
const H_BOTH = "content-transfer-encoding:content-type:date:from:mime-version:subject:list-unsubscribe:list-unsubscribe-post:to:cc:content-type:date:feedback-id:from:subject:to";
const H_NOPOST = "content-type:from:mime-version:subject:list-unsubscribe:x-feedback-id:to:cc:content-type:from:subject:to";
const LINK = "https://u.list.example/unsub/abc123";

{ // ---- 1. DKIM coverage, from the receiving server's own verdict ----
  const dk = mod.__dkimCovers;
  check(dk([AR_DD], [SIG("mrOT7rO/e+", H_BOTH)]) === true, "a passing signature (header.b matches) that covers both headers: one-click allowed");
  check(dk([AR_DD], [SIG("mrOT7rO/e+", H_NOPOST)]) === false, "the signature does not cover List-Unsubscribe-Post (another sender's shape): no one-click");
  check(dk([AR_DD], [SIG("ZZZZZZZZzz", H_BOTH)]) === false, "a signature no verdict passed (header.b differs): no one-click");
  check(dk([AR_DD.replace(/dkim=pass/g, "dkim=fail")], [SIG("mrOT7rO/e+", H_BOTH)]) === false, "DKIM failed: no one-click");
  check(dk([], [SIG("mrOT7rO/e+", H_BOTH)]) === false, "no verdict from the receiving server: no one-click");
  check(dk([AR_DD, "mx.cloudflare.net; dkim=pass header.d=x header.b=QQQQQQQQ"], [SIG("mrOT7rO/e+", H_BOTH)]) === false, "two verdicts must both pass the same signature");
  check(dk([AR_DD], [SIG("fQ0bt2tyAB", H_BOTH)]) === true, "the sending service's own signature counts too (header.b=fQ0bt2ty)");
}
{ // ---- 2. the subject test is the app's, character for character ----
  const app = readFileSync(HUB + "src/client/app.js", "utf8"); const src = (app.match(/^const UNSUB_TXN = (\/.*\/i);$/m) || [])[1];
  check(src === mod.__UNSUB_TXN.toString(), `app.js and index.js carry the same UNSUB_TXN (${src ? "found" : "missing in app.js"})`);
  const T = mod.__UNSUB_TXN;
  for (const s of ["Your order from Corner Grocer has been cancelled", "And it’s off! USPS has your order 🚚", "Jordan, thanks for your order", "Shipped: Acme Desk Lamp...", "Track your Corner Coffee Co. order 📦", "Your receipt from Example Labs #0000", "Your tickets were delivered to your account!", "Order Confirmation: DUNE: PART THREE"]) check(T.test(s), `kept as an order: "${s}"`);
  for (const s of ["Saturdays are for big plays", "NEW: Winter Collections are Here!", "Buy 5, Get 5 FREE Fragrance Oils!", "Jordan, you have new items to review."]) check(!T.test(s), `swept as a promotion: "${s}"`);
  check(T.test("Everything Halloween, delivered"), "the cost, measured at 17 of 350: a promotion whose subject says delivered is kept");
}
{ // ---- 3. a category alone never outranks a block; with no such rules matchSender is unchanged ----
  const ms = mod.__matchSender;
  const old = (rules, addr, account) => { const a = addr.toLowerCase(); const dom = a.split("@")[1] || ""; let best = null; for (const r of rules) { if (r.scope !== "*" && r.scope.toLowerCase() !== account.toLowerCase()) continue; const pat = r.pattern.toLowerCase(); if (!(pat === a || (pat.startsWith("*@") && pat.slice(2) === dom))) continue; if (!best || (r.scope !== "*" && best.scope === "*") || (pat === a && best.pattern.startsWith("*@"))) best = r; if (best && !best.category && r.category && (r.pattern === best.pattern)) best = { ...best, category: r.category }; } return best; };
  const r = ms([{ pattern: "promo@shop.example", action: null, scope: "*", category: "newsletters" }, { pattern: "*@shop.example", action: "block", scope: "*", category: null }], "promo@shop.example", "a@gmail.com");
  check(r?.action === "block" && r?.category === "newsletters", `an unsubscribed address under a later domain block: blocked, still filed as newsletters (${JSON.stringify(r)})`);
  const r2b = ms([{ pattern: "promo@shop.example", action: "accept", scope: "*", category: "newsletters" }, { pattern: "*@shop.example", action: "block", scope: "*", category: null }], "promo@shop.example", "a@gmail.com");
  check(r2b?.action === "accept", "a deliberate address accept still beats the domain block (the screener's exception)");
  const only = ms([{ pattern: "promo@shop.example", action: null, scope: "*", category: "newsletters" }], "promo@shop.example", "a@gmail.com");
  check(only && only.action === null && only.category === "newsletters", "a category alone is still found, for filing");
  // every combination of up to three action-bearing rules across patterns and scopes: the same answer as before
  const pats = ["x@d.example", "*@d.example", "y@d.example"], scopes = ["*", "a@gmail.com", "b@gmail.com"], acts = ["block", "accept", "priority"], cats = [null, "newsletters"];
  let n = 0, diff = 0; const pool = []; for (const p of pats) for (const s of scopes) for (const a of acts) for (const c of cats) pool.push({ pattern: p, scope: s, action: a, category: c });
  for (let i = 0; i < 4000; i++) { const k = 1 + (i % 3); const rules = Array.from({ length: k }, (_, j) => pool[(i * 7919 + j * 104729) % pool.length]); n++; if (JSON.stringify(ms(rules, "x@d.example", "a@gmail.com")) !== JSON.stringify(old(rules, "x@d.example", "a@gmail.com"))) diff++; }
  check(diff === 0, `with no category-only rules, matchSender answers as it did before (${n} rule sets, ${diff} different)`);
}
{ // ---- 4. the migration: accepts that only filed a category lose the accept; everything else is kept ----
  const seed = (sq) => { const ins = sq.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at, category) VALUES (?, ?, ?, ?, ?, ?)"); for (const [id, p, a, c] of [["1", "no-reply@doordash.com", "accept", "newsletters"], ["2", "*@okshop.example", "accept", null], ["3", "bad@spam.example", "block", null], ["4", "friend@site.example", "accept", null], ["5", "*@uspto.today", "block", null], ["6", "pri@vip.example", "priority", "personal"]]) ins.run(id, p, a, "*", "2026-10-01T00:00:00.000Z", c); };
  const { sq, skipped } = buildDb({ upTo: "0042", between: seed });
  check(!skipped.length, `every migration statement ran (${skipped.join(" | ") || "none skipped"})`);
  const rows = Object.fromEntries(sq.prepare("SELECT id, action, category FROM sender_rules").all().map((r) => [r.id, r]));
  check(Object.keys(rows).length === 6, "all six rules survive the rebuild");
  check(rows["1"].action === null && rows["1"].category === "newsletters", "an address filed under Newsletters is a category now, not an accept");
  check(rows["2"].action === "accept" && rows["4"].action === "accept" && rows["3"].action === "block" && rows["5"].action === "block" && rows["6"].action === "priority", "domain accepts, a deliberate address accept, blocks and priority are untouched");
  const idx = sq.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sender_rules'").all().map((r) => r.name);
  check(idx.includes("ux_sender_rules"), "the unique (pattern, scope) index is rebuilt");
  let refused = false; try { sq.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES ('7', 'z@z.example', 'allow', '*', 'x')").run(); } catch (_) { refused = true; }
  check(refused, "an action outside block | accept | priority is still refused");
}

// ---------- the job, through the real route ----------
function world() {
  const { sq } = buildDb(); const store = r2(); const pending = [];
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, status, created_at) VALUES (?, 'x', 'x', 'active', '2026-10-01')").run("me@gmail.com");
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, status, created_at) VALUES (?, 'x', 'x', 'active', '2026-10-01')").run("other@gmail.com");
  for (const a of ["me@gmail.com", "other@gmail.com"]) mod.__tokens.set(a, { access_token: "tok-" + a, exp: Date.now() + 3600e3 });
  const env = { DB: d1(sq), STORE: store, CLI_TOKEN: "cli-token", DOMAINS: "domain2.example" };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (method, path, body) => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers: { Authorization: "Bearer cli-token", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env, ctx); return { status: r.status, body: await r.json().catch(() => null) }; };
  const settle = async () => { for (let i = 0; i < 10 && pending.length; i++) await Promise.allSettled(pending.splice(0)); };
  return { sq, store, env, call, settle, job: (id) => sq.prepare("SELECT * FROM unsubscribes WHERE id = ?").get(id) };
}
const thread = (msgs) => ({ id: "18f3a2b4c5d6e7f8", messages: msgs });
const gmsg = ({ id = "m1", from = "DoorDash <no-reply@doordash.com>", lu = `<${LINK}>, <mailto:unsub@list.example?subject=unsubscribe>`, post = "List-Unsubscribe=One-Click", ar = AR_DD, sigs = [SIG("mrOT7rO/e+", H_BOTH)], labels = ["INBOX", "CATEGORY_PROMOTIONS"] } = {}) =>
  ({ id, threadId: "18f3a2b4c5d6e7f8", labelIds: labels, payload: { headers: [{ name: "Authentication-Results", value: ar }, ...sigs.map((s) => ({ name: "DKIM-Signature", value: s })), { name: "From", value: from }, ...(lu ? [{ name: "List-Unsubscribe", value: lu }] : []), ...(post ? [{ name: "List-Unsubscribe-Post", value: post }] : [])] } });
const meta = (id, threadId, from, subject, lu, labels) => ({ id, threadId, labelIds: labels, payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, ...(lu ? [{ name: "List-Unsubscribe", value: "<https://x.example/u>" }] : [])] } });

{ // ---- 5. a DoorDash-shaped mail: the hub reads the headers, one-click, records the answer, sweeps promotions and keeps the order ----
  const w = world(); sent = [];
  const others = { p1: meta("p1", "t2", "DoorDash <no-reply@doordash.com>", "Saturdays are for big plays", true, ["INBOX", "CATEGORY_PROMOTIONS"]), p2: meta("p2", "t3", "DoorDash <no-reply@doordash.com>", "Track your order from Chipotle", true, ["INBOX", "CATEGORY_PROMOTIONS"]), p3: meta("p3", "t4", "DoorDash <no-reply@doordash.com>", "Your next play could pay off", true, ["INBOX", "CATEGORY_UPDATES"]), p4: meta("p4", "t5", "Dasher <other@doordash.com>", "Big deals", true, ["INBOX", "CATEGORY_PROMOTIONS"]), p5: meta("p5", "t6", "DoorDash <no-reply@doordash.com>", "Everything Halloween, sale", false, ["INBOX", "CATEGORY_PROMOTIONS"]) };
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg()]))],
    [(u) => u.href === LINK, () => new Response("", { status: 200 })],
    [(u) => gmail(u, "messages?") && u.searchParams.get("q").includes("no-reply@doordash.com"), (u, rec) => json(rec.headers.get("authorization") === "Bearer tok-me@gmail.com" ? { messages: Object.values(others).map((m) => ({ id: m.id, threadId: m.threadId })).concat([{ id: "m1", threadId: "18f3a2b4c5d6e7f8" }]) } : {})],
    [(u) => gmail(u, "threads/t") && !u.pathname.endsWith("/trash"), (u) => { const tid = u.pathname.split("/").pop(); const m = Object.values(others).find((x) => x.threadId === tid); return m ? json({ id: tid, messages: [m] }) : json({ error: { message: "gone" } }, 404); }],
    [(u) => gmail(u, "threads/t") && u.pathname.endsWith("/trash"), () => json({})],
  ];
  const r = await w.call("POST", "/api/unsubscribe/job", { id: "job-doordash-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" });
  check(r.status === 200 && r.body?.ok, `the app's request is answered at once (${r.status} ${JSON.stringify(r.body)})`);
  await w.settle();
  const posts = sent.filter((s) => s.url === LINK);
  check(posts.length === 1 && posts[0].method === "POST" && posts[0].body === "List-Unsubscribe=One-Click" && posts[0].redirect === "manual" && !posts[0].headers.has("cookie"), `one RFC 8058 POST from the hub, to the header's URL, no cookie, redirects not followed (${posts.length})`);
  const j = w.job("job-doordash-1");
  check(j.status === "done" && j.outcome === "accepted" && j.method === "one-click" && /answered 200/.test(j.answer), `the list's answer is recorded (${j.status} ${j.outcome} ${j.answer})`);
  const trashed = sent.filter((s) => s.path.endsWith("/trash")).map((s) => s.path.split("/").slice(-2)[0]);
  check(JSON.stringify(trashed) === '["t2"]', `only the promotion's conversation is trashed, whole (${JSON.stringify(trashed)})`);
  check(j.swept === 1 && j.kept === 4, `swept 1; kept the order, the Updates mail, the other address and the one without List-Unsubscribe (${j.swept} / ${j.kept})`);
  check(!sent.some((s) => s.path.endsWith("threads/18f3a2b4c5d6e7f8/trash")), "the conversation itself is left to the app (it trashed it already)");
  const q = sent.find((s) => s.path.startsWith("/gmail/v1/users/me/messages?"));
  check(q && /in:inbox category:promotions -category:purchases/.test(new URL(q.url).searchParams.get("q")), "Gmail's own search narrows it to Promotions in the inbox, never Purchases");
  const who = [...new Set(sent.filter((s) => s.path.startsWith("/gmail/v1/users/me/messages?")).map((s) => s.headers.get("authorization")))].sort();
  check(JSON.stringify(who) === '["Bearer tok-me@gmail.com","Bearer tok-other@gmail.com"]', `every connected account is searched (${who.join(", ")})`);
  const rule = w.sq.prepare("SELECT action, category FROM sender_rules WHERE pattern = 'no-reply@doordash.com'").get();
  check(rule && rule.action === null && rule.category === "newsletters", `the sender is filed under Newsletters with no accept (${JSON.stringify(rule)})`);
  const ev = w.sq.prepare("SELECT kind, detail FROM events WHERE kind LIKE 'unsubscribe%'").all();
  check(ev.some((e) => e.kind === "unsubscribe" && /accepted no-reply@doordash\.com/.test(e.detail)), `the event log has it (${JSON.stringify(ev)})`);
  // the same job sent again (a retry after a lost answer): nothing is sent twice
  sent = []; const again = await w.call("POST", "/api/unsubscribe/job", { id: "job-doordash-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  check(again.status === 200 && sent.filter((s) => s.url === LINK).length === 0, "a retried request is the same job: no second POST");
}
{ // ---- 6. a spoofed one-click with no DKIM coverage: never POSTed; the page is read instead, and it needs the user ----
  const w = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${LINK}>`, sigs: [SIG("mrOT7rO/e+", H_NOPOST)] })]))],
    [(u, rec) => u.href === LINK && rec.method === "GET", () => new Response("<html><body><form><button>Unsubscribe</button></form> Are you sure?</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-spoof-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  const j = w.job("job-spoof-1");
  check(!sent.some((s) => s.url === LINK && s.method === "POST"), "no POST to a link no signature vouches for");
  check(j.outcome === "needs_you" && j.url === LINK && /no passing DKIM/.test(j.answer), `recorded as needing the user, with the page kept (${j.outcome}: ${j.answer})`);
}
{ // ---- 6a. Gmail mail with a second List-Unsubscribe above the signed one: no one-click (RFC 8058: one of each) ----
  const w = world(); sent = [];
  const m = gmsg(); m.payload.headers.unshift({ name: "List-Unsubscribe", value: "<https://evil.example/u>" });
  routes = [[(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([m]))], [(u) => gmail(u, "messages?"), () => json({})]];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-dupe-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  check(!sent.some((x) => /evil\.example|u\.list\.example/.test(x.url)) && /more than one unsubscribe header/.test(w.job("job-dupe-1").answer) && w.job("job-dupe-1").url === null, `two List-Unsubscribe headers: neither link is contacted, not even as a page (${w.job("job-dupe-1").answer})`);
}
{ // ---- 6b. a link that does not exist (a scam from a throwaway Gmail address borrowed Nike's unsubscribe URL,
  // 404 to the one-click and 404 as a page): nothing to leave, so the hub blocks the sender and asks nobody ----
  const w = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${LINK}>` })]))],
    [(u) => u.href === LINK, () => new Response("<html><body><h1>Page not found</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } })],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-gone-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  const j = w.job("job-gone-1");
  check(sent.filter((s) => s.url === LINK && s.method === "POST").length === 1 && sent.filter((s) => s.url === LINK && s.method === "GET").length === 1, "the one-click was tried and the page read, once each");
  check(j.status === "done" && j.outcome === "nothing_there" && /one-click refused by u\.list\.example \(404\)/.test(j.answer) && /blocked instead/.test(j.answer), `closed by the hub as nothing there; the user is not asked (${j.status} ${j.outcome}: ${j.answer})`);
  const rule = w.sq.prepare("SELECT action FROM sender_rules WHERE pattern = 'no-reply@doordash.com' AND scope = '*'").get(), ks = w.sq.prepare("SELECT status FROM known_senders WHERE address = 'no-reply@doordash.com'").get();
  check(rule?.action === "block" && ks?.status === "blocked", `the sender is blocked, as POST /api/senders would do it (${JSON.stringify(rule)} ${JSON.stringify(ks)})`);
  check(!sent.some((s) => s.path.startsWith("/gmail/v1/users/me/messages?")) && j.swept === 0, "no sweep and no Newsletters filing: a mail whose link does not exist is not a list");
  const ev = w.sq.prepare("SELECT kind, detail FROM events").all();
  check(ev.some((e) => e.kind === "gatekeeper" && /blocked 1 no-reply@doordash\.com/.test(e.detail)) && ev.some((e) => e.kind === "unsubscribe" && /nothing_there/.test(e.detail)), `the block and the outcome are in the event log (${JSON.stringify(ev.map((e) => e.kind))})`);
  // CONTROL: a one-click that 404s but a page that exists and says nothing still needs the user, and nothing is blocked
  const w2 = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${LINK}>` })]))],
    [(u, rec) => u.href === LINK && rec.method === "POST", () => new Response("", { status: 404 })],
    [(u, rec) => u.href === LINK && rec.method === "GET", () => new Response("<html><body>Manage your email preferences</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w2.call("POST", "/api/unsubscribe/job", { id: "job-gone-2", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w2.settle();
  check(w2.job("job-gone-2").outcome === "needs_you" && !w2.sq.prepare("SELECT 1 FROM sender_rules WHERE pattern = 'no-reply@doordash.com' AND action = 'block'").get(), `CONTROL — a page that exists but does not say it is done still needs the user, nothing blocked (${w2.job("job-gone-2").outcome})`);
  // CONTROL: a page that cannot be reached is not a page that does not exist
  const w3 = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${LINK}>` })]))],
    [(u, rec) => u.href === LINK && rec.method === "POST", () => new Response("", { status: 404 })],
    [(u, rec) => u.href === LINK && rec.method === "GET", () => { throw new Error("connection reset"); }],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w3.call("POST", "/api/unsubscribe/job", { id: "job-gone-3", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w3.settle();
  check(w3.job("job-gone-3").outcome === "needs_you" && !w3.sq.prepare("SELECT 1 FROM sender_rules WHERE pattern = 'no-reply@doordash.com' AND action = 'block'").get(), `CONTROL — an unreachable page still needs the user, nothing blocked (${w3.job("job-gone-3").outcome}: ${w3.job("job-gone-3").answer})`);
  // CONTROL: a one-click that is refused (403) over a page that 404s: the list's server is there, so the user is asked
  const w4 = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${LINK}>` })]))],
    [(u, rec) => u.href === LINK && rec.method === "POST", () => new Response("", { status: 403 })],
    [(u, rec) => u.href === LINK && rec.method === "GET", () => new Response("<html><body>Not found</body></html>", { status: 404, headers: { "content-type": "text/html" } })],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w4.call("POST", "/api/unsubscribe/job", { id: "job-gone-4", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w4.settle();
  check(w4.job("job-gone-4").outcome === "needs_you", `CONTROL — a refused one-click (403) is not a missing one: the user is asked (${w4.job("job-gone-4").outcome})`);
}
{ // ---- 6b. An unsubscribe email is a command, never the sender's message; a dead link blocks only a PROVEN From ----
  const mailRaw = (w) => { const s1 = sent.filter((x) => x.path.endsWith("messages/send"))[0]; return s1 ? Buffer.from(JSON.parse(s1.body).raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : ""; };
  let w = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: "<mailto:cfo@partner.example?subject=Re:%20invoice%20%23552&body=Please%20use%20our%20new%20bank%20details:%20IBAN%20XX00%20ATTACKER>", post: "" })]))],
    [(u) => gmail(u, "messages/send"), () => json({ id: "sent9" })], [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-phish-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  let raw = mailRaw(w), dec = raw.replace(/=\?utf-8\?B\?([^?]+)\?=/gi, (m0, b) => Buffer.from(b, "base64").toString("utf8")), body = raw.split(/\r?\n\r?\n/).slice(1).join("\n");
  const bodyDec = /base64/i.test(raw) ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") : body;
  check(/^Subject: unsubscribe$/m.test(dec) && /^unsubscribe\s*$/.test(bodyDec.trim()) && !/bank|IBAN|invoice/i.test(dec + bodyDec), `a mailto's own subject and body are not sent: "unsubscribe" goes, not the sender's text (${dec.match(/^Subject:.*$/m)?.[0]} | ${bodyDec.trim().slice(0, 60)})`);
  w = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: "<mailto:listserv@lists.example.edu?subject=x&body=SIGNOFF%20PHYS-L>", post: "" })]))],
    [(u) => gmail(u, "messages/send"), () => json({ id: "sent10" })], [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-listserv", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  raw = mailRaw(w); body = raw.split(/\r?\n\r?\n/).slice(1).join("\n");
  const lb = /base64/i.test(raw) ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") : body;
  check(/SIGNOFF PHYS-L/.test(lb), `… a list's own command is kept ("SIGNOFF PHYS-L") (${lb.trim().slice(0, 40)})`);
  // a dead link on a mail whose From is not proven (no DMARC pass): the unsubscribe is recorded, the address is not blocked
  w = world(); sent = [];
  const AR_FAIL = "mx.google.com; dkim=pass header.i=@sendgrid.info header.s=smtpapi header.b=fQ0bt2ty; spf=softfail smtp.mailfrom=x@evil.example; dmarc=fail (p=NONE) header.from=bank.example";
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ from: "Bank <alerts@bank.example>", lu: `<${LINK}>`, ar: AR_FAIL })]))],
    [(u) => u.href === LINK, () => new Response("<html><body><h1>Page not found</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } })],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-spoof", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "alerts@bank.example" }); await w.settle();
  const j = w.job("job-spoof"), rule = w.sq.prepare("SELECT action FROM sender_rules WHERE pattern = 'alerts@bank.example'").get(), ks = w.sq.prepare("SELECT status FROM known_senders WHERE address = 'alerts@bank.example'").get();
  check(j.outcome === "nothing_there" && !rule && ks?.status !== "blocked" && /NOT blocked: its From is not proven/.test(j.answer) && !/blocked instead/.test(j.answer), `a forged From with a dead link is not blocked, and the answer says so (${JSON.stringify(rule)} ${JSON.stringify(ks)}; ${j.answer})`);
}
{ // ---- 7. the email rung: sent from the address the mail came to, once; a run cut off mid-send does not send again ----
  const w = world(); sent = [];
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: "<mailto:leave@list.example?subject=Remove%20me>", post: "" })]))],
    [(u) => gmail(u, "messages/send"), () => json({ id: "sent1" })],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-mail-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  const s = sent.filter((x) => x.path.endsWith("messages/send"));
  const raw = s[0] ? Buffer.from(JSON.parse(s[0].body).raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
  check(s.length === 1 && /^To: <?leave@list\.example>?/m.test(raw) && /^From: <?me@gmail\.com>?/m.test(raw) && (/^Subject: Remove me$/m.test(raw) || raw.includes("Subject: =?utf-8?B?" + Buffer.from("Remove me").toString("base64") + "?=")), `one email, to the list's address, from the receiving account (${s.length}; ${raw.split("\r\n").filter((l) => /^(To|From|Subject):/.test(l)).join(" | ")})`);
  const j = w.job("job-mail-1");
  check(j.outcome === "email_sent" && /email sent to leave@list\.example/.test(j.answer), `recorded as sent, never as confirmed (${j.outcome}: ${j.answer})`);
  // a run cut off while its email was being handed over (the reservation held): the next run does not send it again
  w.sq.prepare("INSERT INTO unsubscribes (id, created_at, account, thread_id, sender, status, step, claimed_at) VALUES ('job-mail-2', '2026-10-21T00:00:00.000Z', 'me@gmail.com', '18f3a2b4c5d6e7f8', 'no-reply@doordash.com', 'running', 'email', '2026-10-21T00:00:00.000Z')").run();
  w.sq.prepare("INSERT INTO send_claims (key, state, at) VALUES ('unsub-job-mail-2', 'sending', '2026-10-21T00:00:01.000Z')").run();
  sent = []; await mod.__unsubCron(w.env); await w.settle();
  const j2 = w.job("job-mail-2");
  check(!sent.some((x) => x.path.endsWith("messages/send")) && j2.outcome === "email_sent" && /may have sent .* not sent again/.test(j2.answer), `a run cut off mid-send: the cron does not send a second email, and says it may have gone (${j2.outcome}: ${j2.answer})`);
  // a run cut off after marking the step but BEFORE sending: the old guard called this "sent"; now it sends, once
  w.sq.prepare("INSERT INTO unsubscribes (id, created_at, account, thread_id, sender, status, step, claimed_at) VALUES ('job-mail-3', '2026-10-21T00:00:00.000Z', 'me@gmail.com', '18f3a2b4c5d6e7f8', 'no-reply@doordash.com', 'running', 'email', '2026-10-21T00:00:00.000Z')").run();
  sent = []; await mod.__unsubCron(w.env); await w.settle();
  check(sent.filter((x) => x.path.endsWith("messages/send")).length === 1 && w.job("job-mail-3").answer === "email sent to leave@list.example", `a run cut off before the send: the email goes, once (${w.job("job-mail-3").answer})`);
}
{ // ---- 8. Spam is never answered ----
  const w = world(); sent = [];
  routes = [[(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ labels: ["SPAM"] })]))]];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-spam-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  const j = w.job("job-spam-1");
  check(j.outcome === "spam" && !sent.some((s) => s.url.startsWith("https://u.list.example") || s.path.endsWith("messages/send")), `mail in Spam: the sender is not contacted (${j.outcome})`);
  check(!sent.some((s) => s.path.startsWith("/gmail/v1/users/me/messages?")), "and nothing is swept");
}
{ // ---- 9. hub mail: Cloudflare's stamps and the stored signature decide; the hub sweep keeps orders and mail without the header ----
  const w = world(); sent = [];
  const sig = "v=1; a=rsa-sha256; d=send.shop.example; s=k1; h=from:subject:list-unsubscribe:list-unsubscribe-post; bh=xx=; b=Qw3rTy12ABCDEFGH==";
  const raw = ["Authentication-Results: mx.cloudflare.net; dkim=pass header.d=send.shop.example header.s=k1 header.b=Qw3rTy12; dmarc=pass header.from=shop.example", "ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=send.shop.example header.s=k1 header.b=Qw3rTy12; dmarc=pass", "DKIM-Signature: " + sig, "From: Shop <news@shop.example>", "Subject: Winter sale", "", "body"].join("\r\n");
  await w.store.put("raw/a.eml", raw);
  const ins = w.sq.prepare("INSERT INTO threads (id, state) VALUES (?, 'inbox')"), msg = w.sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, list_unsubscribe, list_unsubscribe_post, raw_key, ingest_source, created_at) VALUES (?, ?, 'in', 'sam@domain2.example', ?, ?, ?, ?, ?, 'cloudflare', ?)");
  const T = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  for (let n = 1; n <= 5; n++) ins.run(T(n));
  msg.run("m1", T(1), "news@shop.example", "Winter sale", `<${LINK}>`, "List-Unsubscribe=One-Click", "raw/a.eml", "2026-10-20T00:00:00.000Z");
  msg.run("m2", T(2), "news@shop.example", "Buy 5, get 5", `<${LINK}>`, "List-Unsubscribe=One-Click", null, "2026-10-19T00:00:00.000Z");
  msg.run("m3", T(3), "news@shop.example", "Your order #1234 has shipped", `<${LINK}>`, "List-Unsubscribe=One-Click", null, "2026-10-18T00:00:00.000Z");
  msg.run("m4", T(4), "news@shop.example", "A note from the owner", null, null, null, "2026-10-17T00:00:00.000Z");
  msg.run("m5", T(5), "other@shop.example", "Other list", `<${LINK}>`, "List-Unsubscribe=One-Click", null, "2026-10-16T00:00:00.000Z");
  // the From is proven, as ingest stores Cloudflare's first stamp for mail it received: the sweep needs that
  w.sq.prepare("UPDATE messages SET auth_results = ? WHERE id = 'm1'").run("mx.cloudflare.net; dkim=pass header.d=send.shop.example header.s=k1 header.b=Qw3rTy12; dmarc=pass header.from=shop.example");
  routes = [[(u) => u.href === LINK, () => new Response(null, { status: 302, headers: { location: "https://shop.example/bye" } })], [(u) => gmail(u, "messages?"), () => json({})]];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-hub-1", account: "hub", thread: T(1), sender: "news@shop.example" }); await w.settle();
  const j = w.job("job-hub-1");
  check(sent.filter((s) => s.url === LINK && s.method === "POST").length === 1 && j.outcome === "accepted" && /answered 302/.test(j.answer), `hub mail: Cloudflare's two stamps and the stored signature allow one POST (${j.outcome}: ${j.answer})`);
  const st = Object.fromEntries(w.sq.prepare("SELECT id, state FROM threads").all().map((r) => [r.id, r.state]));
  check(st[T(2)] === "trash", "the sender's other promotion is trashed");
  check(st[T(3)] === "inbox" && st[T(4)] === "inbox" && st[T(5)] === "inbox", `kept: the shipped order, the mail without List-Unsubscribe, the other address (${st[T(3)]} ${st[T(4)]} ${st[T(5)]})`);
  check(st[T(1)] === "inbox", "the conversation itself is the app's to trash (its own queue, with Undo)");
  // a lookalike stamp the sender wrote under a missing Cloudflare one: no POST
  const w2 = world(); sent = [];
  await w2.store.put("raw/b.eml", raw.replace(/^Authentication-Results: mx\.cloudflare\.net/m, "Authentication-Results: mx.attacker.example"));
  w2.sq.prepare("INSERT INTO threads (id, state) VALUES (?, 'inbox')").run(T(1));
  w2.sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, list_unsubscribe, list_unsubscribe_post, raw_key, ingest_source, created_at) VALUES ('m1', ?, 'in', 'sam@domain2.example', 'news@shop.example', 'Sale', ?, 'List-Unsubscribe=One-Click', 'raw/b.eml', 'cloudflare', '2026-10-20T00:00:00.000Z')").run(T(1), `<${LINK}>`);
  routes = [[(u, rec) => u.href === LINK && rec.method === "GET", () => new Response("<p>You have been unsubscribed.</p>", { status: 200, headers: { "content-type": "text/html" } })], [(u) => gmail(u, "messages?"), () => json({})]];
  await w2.call("POST", "/api/unsubscribe/job", { id: "job-hub-2", account: "hub", thread: T(1), sender: "news@shop.example" }); await w2.settle();
  const j2 = w2.job("job-hub-2");
  check(!sent.some((s) => s.url === LINK && s.method === "POST") && j2.outcome === "confirmed", `not Cloudflare's stamp: no POST; the page, which says it is done, is read instead (${j2.outcome}: ${j2.answer})`);
}
{ // ---- 10. what the route refuses ----
  const w = world();
  for (const [b, code, why] of [[{ id: "short", account: "hub", thread: "00000000-0000-4000-8000-000000000001", sender: "a@b.example" }, 400, "a bad job id"], [{ id: "job-x-123456", account: "hub", thread: "not-a-uuid", sender: "a@b.example" }, 400, "a bad hub thread"], [{ id: "job-x-123456", account: "stranger@gmail.com", thread: "abc123", sender: "a@b.example" }, 404, "an account that is not connected"], [{ id: "job-x-123456", account: "me@gmail.com", thread: "abc123", sender: "not an address" }, 400, "a sender that is not an address"]]) {
    const r = await w.call("POST", "/api/unsubscribe/job", b); check(r.status === code, `refused: ${why} (${r.status})`);
  }
  check(w.sq.prepare("SELECT COUNT(*) n FROM unsubscribes").get().n === 0, "nothing was queued for any of them");
  const r = await w.call("GET", "/api/unsubscribes"); check(r.status === 200 && Array.isArray(r.body?.unsubscribes), "the list of unsubscribes answers");
  const anon = await mod.default.fetch(new Request("https://hub.example/api/unsubscribe/job", { method: "POST", body: "{}" }), w.env, { waitUntil: () => {} });
  check(anon.status === 401 || anon.status === 403, `only the signed-in app or the CLI may ask (${anon.status})`);
}
{ // ---- 11. "Category: back to automatic" and the category-only write through the route ----
  const w = world();
  let r = await w.call("POST", "/api/sender-rules", { pattern: "promo@shop.example", category: "newsletters" });
  check(r.status === 200 && r.body?.rule?.action === null && r.body.rule.category === "newsletters", `filing a sender stores a category and no action (${JSON.stringify(r.body?.rule)})`);
  r = await w.call("POST", "/api/sender-rules", { pattern: "promo@shop.example", category: null });
  check(r.status === 200 && r.body?.rule === null && !w.sq.prepare("SELECT 1 FROM sender_rules WHERE pattern = 'promo@shop.example'").get(), `back to automatic removes a rule that only held the category (${r.status})`);
  await w.call("POST", "/api/sender-rules", { pattern: "vip@shop.example", action: "priority" });
  r = await w.call("POST", "/api/sender-rules", { pattern: "vip@shop.example", category: "personal" });
  check(r.body?.rule?.action === "priority" && r.body.rule.category === "personal", "a category added to a priority sender keeps the priority");
  r = await w.call("POST", "/api/sender-rules", { pattern: "vip@shop.example", category: null });
  check(r.body?.rule?.action === "priority" && r.body.rule.category === null, "back to automatic on it keeps the priority and drops the category");
  r = await w.call("POST", "/api/sender-rules", { pattern: "x@shop.example" });
  check(r.status === 400, "a rule with neither an action nor a category is refused");
}
{ // ---- 12. the "Yes, I'm sure" form (slice 2): sent when it is the page's one simple form and its button says unsubscribe ----
  const page = (body) => `<html><body>${body}</body></html>`;
  const F = mod.__unsubForm;
  const f1 = F(page(`<p>Unsubscribe x@me.example from Shop News?</p><form method="post" action="/u/confirm"><input type="hidden" name="t" value="tok&amp;1"><input type="email" name="email"><button type="submit">Yes, unsubscribe me</button></form>`), "https://shop.example/u?id=1", "x@me.example");
  check(f1 && f1.method === "POST" && f1.action.href === "https://shop.example/u/confirm" && f1.body === "t=tok%261&email=x%40me.example" && f1.label === "Yes, unsubscribe me", `the simple form: POST, its action, the token, the receiving address in the empty email field (${JSON.stringify(f1 && { m: f1.method, a: f1.action.href, b: f1.body, l: f1.label })})`);
  const f2 = F(page(`<p>Are you sure you want to unsubscribe?</p><form action="https://shop.example/out?old=1"><input type="hidden" name="id" value="7"><input type="submit" value="Confirm"></form>`), "https://shop.example/u", "x@me.example");
  check(f2 && f2.method === "GET" && f2.action.href === "https://shop.example/out?id=7", `a GET form: its fields replace the action's query (${f2 && f2.action.href})`);
  for (const [html, why] of [
    [`<p>You have been unsubscribed.</p><form action="/re"><button>Resubscribe</button></form>`, "a Resubscribe button"],
    [`<form action="/p"><button>Update preferences</button></form>`, "a preferences form"],
    [`<form action="/u"><button>Unsubscribe</button><button>Cancel</button></form>`, "two buttons: a choice"],
    [`<form action="/u"><input name="q"><button>Unsubscribe</button></form><form action="/s"><button>Search</button></form>`, "two forms"],
    [`<form action="/u"><select name="r"><option>a</option></select><button>Unsubscribe</button></form>`, "a select"],
    [`<form action="/u"><input type="checkbox" name="all"><button>Unsubscribe</button></form>`, "a checkbox"],
    [`<form action="/u"><input type="password" name="pw"><button>Unsubscribe</button></form>`, "a password field"],
    [`<form action="/u"><div class="g-recaptcha"></div><button>Unsubscribe</button></form>`, "a CAPTCHA"],
    [`<iframe src="x"></iframe><form action="/u"><button>Unsubscribe</button></form>`, "an iframe"],
    [`<form action="http://shop.example/u"><button>Unsubscribe</button></form>`, "a plain-http action"],
    [`<form action="/u"><input type="hidden" name="id" value="1"></form><script>document.forms[0].submit()</script>`, "no button (a script sends it)"],
    [`<form action="/u"><input type="email" name="email"><button>Unsubscribe</button></form>`, "an email field and no receiving address"],
    [`<p>Are you sure you want to unsubscribe?</p><form method="post" action="/s"><input type="hidden" name="mode" value="subscribe"><button>Yes</button></form>`, "a Yes form whose hidden field subscribes"],
    [`<form action="/s"><button>Confirm subscription</button></form>`, "Confirm subscription"],
    [`<p>Do you want to keep receiving our deals?</p><form action="/k"><button>Yes</button></form>`, "a Yes that is not answering an unsubscribe question"],
    [`<p>Are you sure you want to unsubscribe?</p><form action="/u"><button>Yes, keep me subscribed</button></form>`, "a button that keeps the subscription"],
  ]) check(F(page(html), "https://shop.example/u", why.includes("no receiving") ? "" : "x@me.example") === null, `not sent: ${why}`);
  const w = world(); sent = [];
  const FORM = page(`<h1>Are you sure?</h1><form method="post" action="/u/confirm"><input type="hidden" name="t" value="tok1"><input type="email" name="email"><button>Yes, unsubscribe me</button></form>`);
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${LINK}>`, post: "" })]))],
    [(u, rec) => u.href === LINK && rec.method === "GET", () => new Response(FORM, { status: 200 })],
    [(u, rec) => u.href === "https://u.list.example/u/confirm" && rec.method === "POST", () => new Response(null, { status: 303, headers: { location: "https://u.list.example/u/done" } })],
    [(u, rec) => u.href === "https://u.list.example/u/done" && rec.method === "GET", () => new Response(page("<p>You have been unsubscribed from Shop News.</p>"), { status: 200 })],
    [(u) => gmail(u, "messages?"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-form-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  const j = w.job("job-form-1"), post = sent.find((x) => x.method === "POST" && x.url.endsWith("/u/confirm"));
  check(post && post.body === "t=tok1&email=me%40gmail.com" && post.headers.get("content-type") === "application/x-www-form-urlencoded" && !post.headers.has("cookie"), `the form is sent with its token and the receiving address, no cookie (${post && post.body})`);
  check(sent.some((x) => x.url.endsWith("/u/done") && x.method === "GET"), "a 303 after the POST is followed with a GET, as a browser does");
  check(j.outcome === "confirmed" && j.method === "form" && /after its "Yes, unsubscribe me" button/.test(j.answer), `recorded as confirmed by the page the form led to (${j.outcome} ${j.method}: ${j.answer})`);
  // the page already unsubscribed and offers to undo it: its form is never sent
  const w2 = world(); sent = [];
  routes = [[(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${LINK}>`, post: "" })]))], [(u, rec) => u.href === LINK && rec.method === "GET", () => new Response(page(`<p>You've been unsubscribed.</p><form method="post" action="/re"><button>Resubscribe</button></form>`), { status: 200 })], [(u) => gmail(u, "messages?"), () => json({})]];
  await w2.call("POST", "/api/unsubscribe/job", { id: "job-form-2", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w2.settle();
  check(!sent.some((x) => x.method === "POST" && x.url.includes("/re")) && w2.job("job-form-2").outcome === "confirmed", `a page that is done and offers Resubscribe: confirmed, and its form is never sent (${w2.job("job-form-2").outcome})`);
}
{ // ---- 13. work-mailbox mail (IMAP, no receiving server's verdict): the hub checks the DKIM signature itself ----
  // Measured on two of the user's stored work-mailbox list mails, 2026-10-21 (RTO via Salesforce, a data vendor via SendGrid): both
  // verify against their live DNS keys and fail once List-Unsubscribe is altered. Here a key made for the test signs the same way.
  const { generateKeyPairSync, createSign } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const p64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const relaxed = (n, v) => `${n.toLowerCase()}:${v.replace(/\r\n(?=[ \t])/g, "").replace(/[ \t]+/g, " ").trim()}`;
  const HDRS = [["From", "RTO <rto@lists.rto.example>"], ["To", "sam@work.example"], ["Subject", "[Outage] Maintenance"], ["List-Unsubscribe", ` <${LINK}>`], ["List-Unsubscribe-Post", " List-Unsubscribe=One-Click"]];
  const { createHash } = await import("node:crypto"); const bhOf = (body) => createHash("sha256").update(body.replace(/(?:\r\n)*$/, "") + "\r\n").digest("base64");   // relaxed body: "body" -> "body\r\n"
  const sigNoB = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=lists.rto.example; s=sel1;\r\n h=From:To:Subject:List-Unsubscribe:List-Unsubscribe-Post; bh=${bhOf("body")}; b=`;
  const data = HDRS.map(([n, v]) => relaxed(n, v) + "\r\n").join("") + relaxed("DKIM-Signature", sigNoB);
  const b = createSign("RSA-SHA256").update(data).sign(privateKey, "base64");
  const raw = (hs, body = "body") => ["Received: from mx1.mailhost.example by mx1 with LMTP", "DKIM-Signature: " + sigNoB + b.slice(0, 60) + "\r\n " + b.slice(60), ...hs.map(([n, v]) => `${n}:${v}`), "", body].join("\r\n");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => { const u = new URL(typeof input === "string" ? input : input.url); if (u.hostname === "cloudflare-dns.com" && u.searchParams.get("type") === "TXT") return new Response(JSON.stringify({ Answer: u.searchParams.get("name") === "sel1._domainkey.lists.rto.example" ? [{ type: 16, data: `"v=DKIM1; k=rsa; " "p=${p64.slice(0, 200)}" "${p64.slice(200)}"` }] : [] })); return realFetch(input, init); };
  const T1 = "00000000-0000-4000-8000-0000000000a1";
  const run = async (id, rawText) => {
    const w = world(); sent = []; await w.store.put("raw/w.eml", rawText);
    w.sq.prepare("INSERT INTO threads (id, state) VALUES (?, 'inbox')").run(T1);
    w.sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, list_unsubscribe, list_unsubscribe_post, raw_key, ingest_source, created_at) VALUES ('w1', ?, 'in', 'sam@work.example', 'rto@lists.rto.example', '[Outage] Maintenance', ?, 'List-Unsubscribe=One-Click', 'raw/w.eml', 'imap', '2026-10-20T00:00:00.000Z')").run(T1, `<${LINK}>`);
    routes = [[(u, rec) => u.href === LINK && rec.method === "POST", () => new Response("", { status: 202 })], [(u, rec) => u.href === LINK && rec.method === "GET", () => new Response("<p>Manage your subscription</p>", { status: 200 })], [(u) => gmail(u, "messages?"), () => json({})]];
    await w.call("POST", "/api/unsubscribe/job", { id, account: "hub", thread: T1, sender: "rto@lists.rto.example" }); await w.settle(); return w.job(id);
  };
  let j = await run("job-imap-1", raw(HDRS));
  check(sent.filter((x) => x.url === LINK && x.method === "POST").length === 1 && j.outcome === "accepted" && /answered 202/.test(j.answer), `IMAP mail with a valid signature over the unsubscribe headers gets the one-click (${j.outcome}: ${j.answer})`);
  j = await run("job-imap-2", raw(HDRS.map(([n, v]) => [n, n === "List-Unsubscribe" ? " <https://evil.example/u>" : v])));
  check(!sent.some((x) => x.method === "POST"), `an altered List-Unsubscribe fails the signature: no POST (${j.outcome})`);
  j = await run("job-imap-3", raw(HDRS, "a different body"));
  check(!sent.some((x) => x.method === "POST"), `an altered body fails the body hash: no POST, the signature is not valid (${j.outcome})`);
  j = await run("job-imap-4", raw([["List-Unsubscribe", " <https://evil.example/u>"], ...HDRS]));
  check(!sent.some((x) => /evil\.example|u\.list\.example/.test(x.url)) && /more than one unsubscribe header/.test(j.answer), `a second List-Unsubscribe written above a signed one: nothing is contacted (${j.answer})`);
  globalThis.fetch = realFetch;
}
{ // ---- 14. still mailing after the FTC's 10 business days (slice 3), with DoorDash's real dates ----
  const bd = mod.__bdays;
  check(bd("2026-10-09T17:54:49.000Z", 10).toISOString() === "2026-10-23T17:54:49.000Z", `10 business days after Friday 10-09 is Friday 10-23 (${bd("2026-10-09T17:54:49.000Z", 10).toISOString()})`);
  const w = world(); const ins = w.sq.prepare("INSERT INTO unsubscribes (id, created_at, account, thread_id, sender, status, outcome) VALUES (?, '2026-10-09T17:54:49.000Z', 'me@gmail.com', 'abc123', ?, 'done', ?)");
  ins.run("still-1", "no-reply@doordash.com", "accepted"); ins.run("still-2", "x@needs.example", "needs_you"); ins.run("still-3", "y@kept.example", "accepted");
  w.sq.prepare("UPDATE unsubscribes SET dismissed_at = '2026-10-20T00:00:00.000Z' WHERE id = 'still-3'").run();
  const note = (addr, iso, ref = iso) => mod.__noteArrival(w.env.DB, mod.__jobsLoader(w.env.DB), addr, "60% off candy", Date.parse(iso), ref);
  await note("no-reply@doordash.com", "2026-10-21T19:13:00.000Z");
  check(w.job("still-1").still_count === 0, "DoorDash on 10-21 (business day 8): inside the FTC window, not flagged");
  await note("No-Reply@DoorDash.com", "2026-10-26T15:00:00.000Z", "msg-a"); await note("no-reply@doordash.com", "2026-10-26T15:00:20.000Z", "msg-a");
  check(w.job("still-1").still_count === 1 && w.job("still-1").still_subject === "60% off candy", `on 10-26 it is flagged, once for one message two runs both saw (${w.job("still-1").still_count})`);
  await note("no-reply@doordash.com", "2026-10-26T15:00:30.000Z", "msg-b");
  check(w.job("still-1").still_count === 2, "a second message ten seconds later counts too");
  await note("x@needs.example", "2026-11-20T00:00:00.000Z"); await note("y@kept.example", "2026-11-20T00:00:00.000Z");
  check(w.job("still-2").still_count === 0 && w.job("still-3").still_count === 0, "not for a job that never reached the list, nor one the user answered Keep");
  // the arrival path itself: a Gmail poll that sees the sender's new mail
  routes = [
    [(u) => gmail(u, "history?"), () => json({ historyId: "200", history: [{ id: "150", messagesAdded: [{ message: { id: "gnew1", threadId: "tnew1", labelIds: ["INBOX", "UNREAD"] } }] }] })],
    [(u) => gmail(u, "messages/gnew1?"), () => json({ id: "gnew1", threadId: "tnew1", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "DoorDash <no-reply@doordash.com>" }, { name: "Subject", value: "Back again" }] } })],
  ];
  w.sq.prepare("UPDATE gmail_accounts SET poll_history_id = '100' WHERE email = 'me@gmail.com'").run(); w.sq.prepare("UPDATE gmail_accounts SET status = 'revoked' WHERE email = 'other@gmail.com'").run();
  w.sq.prepare("UPDATE unsubscribes SET created_at = '2026-09-01T00:00:00.000Z', still_at = NULL WHERE id = 'still-1'").run();
  const before = w.job("still-1").still_count;
  await mod.default.scheduled({ scheduledTime: Date.parse("2026-10-21T20:01:00.000Z") }, { ...w.env, GMAIL_CLIENT_ID: "c", GMAIL_CLIENT_SECRET: "s", GMAIL_TOKEN_KEY: "k" }, { waitUntil: () => {} });   // the poll runs only where Gmail is configured
  check(w.job("still-1").still_count === before + 1 && w.job("still-1").still_subject === "Back again", `the Gmail poll notes it as the mail arrives (${before} -> ${w.job("still-1").still_count}, ${w.job("still-1").still_subject})`);
}
{ // ---- 15. the user's answers on the list ----
  const w = world();
  w.sq.prepare("INSERT INTO unsubscribes (id, created_at, account, thread_id, sender, status, outcome, answer) VALUES ('ans-12345', '2026-10-21T00:00:00.000Z', 'me@gmail.com', 'abc123', 'a@b.example', 'done', 'needs_you', 'its page wants a click')").run();
  let r = await w.call("POST", "/api/unsubscribes/ans-12345", { answer: "done" });
  const j = w.job("ans-12345");
  check(r.status === 200 && j.outcome === "handled" && !!j.dismissed_at && /finished on the page by hand/.test(j.answer), `"Done" on a page that needed the user: handled, off the count (${j.outcome})`);
  r = await w.call("POST", "/api/unsubscribes/ans-12345", { answer: "maybe" }); check(r.status === 400, "an answer other than done | keep is refused");
  r = await w.call("POST", "/api/unsubscribes/nope-12345", { answer: "keep" }); check(r.status === 404, "an unknown row is 404");
  r = await w.call("GET", "/api/unsubscribes"); const row = (r.body?.unsubscribes || []).find((x) => x.id === "ans-12345");
  check(row && "still_count" in row && "dismissed_at" in row, "the list carries the still-mailing and answered fields");
}
{ // ---- 16a. a conversation holding a promotion and an order from the sender is kept whole ----
  const w = world(); sent = [];
  const pm = meta("x1", "tx", "DoorDash <no-reply@doordash.com>", "Big plays", true, ["INBOX", "CATEGORY_PROMOTIONS"]), om = meta("x2", "tx", "DoorDash <no-reply@doordash.com>", "Your order #77 is on its way", true, ["INBOX", "CATEGORY_PROMOTIONS"]);
  routes = [[(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg()]))], [(u) => u.href === LINK, () => new Response("", { status: 200 })],
    [(u) => gmail(u, "messages?"), (u, rec) => json(rec.headers.get("authorization") === "Bearer tok-me@gmail.com" ? { messages: [{ id: "x1", threadId: "tx" }] } : {})],
    [(u) => gmail(u, "threads/tx") && !u.pathname.endsWith("/trash"), () => json({ id: "tx", messages: [pm, om] })], [(u) => gmail(u, "threads/tx/trash"), () => json({})]];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-mixed-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  check(!sent.some((x) => x.path.endsWith("/trash")) && w.job("job-mixed-1").kept === 1, `a conversation with an order in it is not trashed, not even its promotion (kept ${w.job("job-mixed-1").kept})`);
}
{ // ---- 16. the sweep pages past a first page that was all kept ----
  const w = world(); sent = [];
  const orders = Array.from({ length: 20 }, (_, i) => meta(`o${i}`, `to${i}`, "DoorDash <no-reply@doordash.com>", `Your order #${i} is on its way`, true, ["INBOX", "CATEGORY_PROMOTIONS"]));
  const promo = meta("pp1", "tp1", "DoorDash <no-reply@doordash.com>", "Big plays this weekend", true, ["INBOX", "CATEGORY_PROMOTIONS"]);
  const all = Object.fromEntries([...orders, promo].map((m) => [m.id, m]));
  routes = [
    [(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg()]))], [(u) => u.href === LINK, () => new Response("", { status: 200 })],
    [(u) => gmail(u, "messages?") && !u.searchParams.get("pageToken"), (u, rec) => json(rec.headers.get("authorization") === "Bearer tok-me@gmail.com" ? { messages: orders.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: "p2" } : {})],
    [(u) => gmail(u, "messages?") && u.searchParams.get("pageToken") === "p2", () => json({ messages: [{ id: "pp1", threadId: "tp1" }] })],
    [(u) => gmail(u, "threads/t") && !u.pathname.endsWith("/trash"), (u) => { const tid = u.pathname.split("/").pop(); const m = Object.values(all).find((x) => x.threadId === tid); return m ? json({ id: tid, messages: [m] }) : json({ error: { message: "gone" } }, 404); }],
    [(u) => gmail(u, "threads/t") && u.pathname.endsWith("/trash"), () => json({})],
  ];
  await w.call("POST", "/api/unsubscribe/job", { id: "job-page-1", account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
  for (let i = 0; i < 4 && w.job("job-page-1").status !== "done"; i++) { w.sq.prepare("UPDATE unsubscribes SET claimed_at = NULL WHERE id = 'job-page-1'").run(); await mod.__unsubCron(w.env); }
  const trashed = sent.filter((x) => x.path.endsWith("/trash")).map((x) => x.path.split("/").slice(-2)[0]);
  check(JSON.stringify(trashed) === '["tp1"]' && w.job("job-page-1").kept === 20, `twenty orders kept on page one, the promotion on page two trashed (${JSON.stringify(trashed)}, kept ${w.job("job-page-1").kept}, ${w.job("job-page-1").status})`);
}
{ // ---- 17. the addresses the hub never sends to, from a header it read itself (they were the retired endpoint's checks) ----
  for (const [link, why] of [["https://localhost/u", "localhost"], ["https://printer.lan/u", "a home-network name"], ["https://sneaky.example/u", "a name that resolves to a private address"], ["https://user:secret@list.example/u", "a link with a password in it"]]) {
    const w = world(); sent = [];
    routes = [[(u) => gmail(u, "threads/18f3a2b4c5d6e7f8"), () => json(thread([gmsg({ lu: `<${link}>` })]))], [(u) => gmail(u, "messages?"), () => json({})]];
    await w.call("POST", "/api/unsubscribe/job", { id: "job-bad-" + why.replace(/\W+/g, "-").slice(0, 30), account: "me@gmail.com", thread: "18f3a2b4c5d6e7f8", sender: "no-reply@doordash.com" }); await w.settle();
    const host = new URL(link).hostname;
    check(!sent.some((x) => new URL(x.url).hostname === host), `never contacted: ${why} (${sent.filter((x) => new URL(x.url).hostname === host).length} request(s))`);
  }
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
