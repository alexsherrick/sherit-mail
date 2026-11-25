#!/usr/bin/env node
// EXECUTION test: the letterhead. The real Worker over the real migrations in SQLite, a fake R2 and a fake send
// binding, through the real fetch(). Checks that a send from an address on a branded domain (BRANDS in wrangler.toml) goes out with
// its HTML part wrapped in the frame, the text escaped and the plain-text part as written; that a send from any other domain carries
// nothing extra; that `plain` skips the frame; that Markdown HTML is framed too; that a reply quotes the mail it answers under
// "On …, X wrote:" and keeps its threading headers; the original's HTML as light HTML (links, bold, breaks kept; styles, scripts,
// pictures, handlers and stray closing tags gone), a text-only original escaped as before; that the Sent copy holds
// the framed HTML; that the frame carries no dark-mode rule or filter;
// and that /api/me names the domains.
// CONTROL: BRAND_SRC=<the Worker before the change> fails at the first check. Usage: node test/brand.mjs (exit 1 on any failure)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq) => { const run = (sql, p, kind) => { const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => { sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } }; };
const SRC = readFileSync(process.env.BRAND_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_brand_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const LOGO = "https://domain7.example/assets/logo_email.png";
function world() {
  const sq = buildDb(); const objs = new Map(); const sends = [];
  sq.prepare("INSERT INTO identities (email, display_name, is_active, domain) VALUES ('sam@domain2.example', 'Sam', 1, 'domain2.example')").run();
  sq.prepare("INSERT INTO identities (email, display_name, is_active, domain) VALUES ('support@domain7.example', 'Brandseven Support', 1, 'domain7.example')").run();
  const env = { DB: d1(sq), CLI_TOKEN: "cli-token", DOMAINS: "domain2.example,domain7.example",
    BRANDS: JSON.stringify({ "domain7.example": { name: "Brandseven", logo: LOGO, color: "#f97316", site: "https://domain7.example", footer: "Have more questions? Just reply to this email." } }),
    STORE: { put: async (k, v) => { objs.set(k, v); }, get: async (k) => (objs.has(k) ? { body: objs.get(k), arrayBuffer: async () => new ArrayBuffer(0) } : null), list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); } },
    EMAIL: { send: async (m) => { sends.push(m); return { messageId: `<p${sends.length}@hub.test>` }; } } };
  const call = async (path, body, method = "POST") => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers: { Authorization: "Bearer cli-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: () => {} }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { sq, env, sends, objs, call };
}

{ // a send from a branded address: the frame around the escaped text; the plain-text part as written
  const w = world();
  const text = "Hi <Steve> & co,\nIt works now.\n\nSam";
  const r = await w.call("/api/send", { from: "support@domain7.example", to: ["steve@example.com"], subject: "Re: setup", text });
  check(r.status === 200 && w.sends.length === 1, `the send goes (${r.status})`);
  const m = w.sends[0] || {};
  check(typeof m.html === "string" && m.html.includes(LOGO) && m.html.includes(">Brandseven<"), "its HTML part carries the Brandseven frame (logo and wordmark)");
  check(!/prefers-color-scheme/i.test(m.html || "") && !/\bfilter\s*:/i.test(m.html || ""), "no dark-mode rule and no filter in the frame: the logo stays yellow on the white card in dark mode too");
  if (process.env.BRAND_DUMP) writeFileSync(process.env.BRAND_DUMP, m.html || "");   // the framed HTML, for a render check outside this test
  check((m.html || "").includes("Hi &lt;Steve&gt; &amp; co,<br>It works now.<br><br>Sam"), "the text inside is escaped, line breaks kept");
  check((m.html || "").includes("Have more questions? Just reply to this email.") && (m.html || "").includes("domain7.example</a>"), "the footer line and the site link are there");
  check(m.text === text, "the plain-text part is exactly what was written");
  check(m.from && m.from.email === "support@domain7.example" && m.from.name === "Brandseven Support", `From keeps the identity's name (${JSON.stringify(m.from)})`);
  const row = w.sq.prepare("SELECT body_html, body_text FROM messages WHERE direction = 'out' ORDER BY created_at DESC LIMIT 1").get();
  check(row && row.body_html.includes(LOGO) && row.body_text === text, "the Sent copy holds the framed HTML and the written text");
}
{ // web addresses in a branded plain-text send become links; text around them still escaped; punctuation stays outside
  const w = world();
  // example.com, not the brand's own domain: the public copy renames that to a.example one, which the linker does not take as a domain
  const text = "Get it: https://example.com/app/id123.\nOn Android? Join at example.com/android.\nMail sam@example.com, <b> & co.";
  const r = await w.call("/api/send", { from: "hello@domain7.example", to: ["c@example.com"], subject: "App", text });
  const h = (w.sends[0] || {}).html || "";
  check(r.status === 200 && h.includes('Get it: <a href="https://example.com/app/id123">https://example.com/app/id123</a>.<br>'), "an https address is a link, its full stop outside it");
  check(h.includes('Join at <a href="https://example.com/android">example.com/android</a>.<br>'), "a bare domain with a path is a link to https://");
  check(h.includes("Mail sam@example.com, &lt;b&gt; &amp; co.") && !h.includes('href="https://example.com,'), "an email address is not linked and the text around is escaped");
  check(((w.sends[0] || {}).text) === text, "the plain-text part is still exactly what was written");
}
{ // a send from another of the user's domains: nothing added
  const w = world();
  const r = await w.call("/api/send", { from: "sam@domain2.example", to: ["friend@example.com"], subject: "Dinner", text: "Thursday?" });
  const m = w.sends[0] || {};
  check(r.status === 200 && m.text === "Thursday?" && m.html === undefined, `domain2.example goes out as before: text only, no HTML part (${r.status}, html ${typeof m.html})`);
}
{ // plain: the frame is skipped on purpose
  const w = world();
  const r = await w.call("/api/send", { from: "support@domain7.example", to: ["steve@example.com"], subject: "Quick one", text: "Just me.", plain: true });
  const m = w.sends[0] || {};
  check(r.status === 200 && m.html === undefined && m.text === "Just me.", `plain sends it bare (${r.status}, html ${typeof m.html})`);
}
{ // Markdown HTML from the client is framed, not replaced
  const w = world();
  const r = await w.call("/api/send", { from: "support@domain7.example", to: ["steve@example.com"], subject: "Steps", text: "1. open\n2. tap", html: "<ol><li>open</li><li>tap</li></ol>" });
  const m = w.sends[0] || {};
  check(r.status === 200 && (m.html || "").includes("<ol><li>open</li><li>tap</li></ol>") && (m.html || "").includes(LOGO), "the client's HTML sits inside the frame");
}
{ // a reply quotes the customer's mail (its HTML as light HTML) and keeps its threading headers
  const w = world();
  w.sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread) VALUES ('t1', 'setup', '[\"steve@example.com\"]', '2026-10-22T14:35:09.000Z', 1, 'inbox', 1)").run();
  // what Gmail sends: the text part flattens the link to `LinkedIn <https://…>` and bold to `*Steve*`; the HTML part has them, plus a
  // tracking pixel, a style block, a script, a javascript: link with a handler, a stray </td></tr></table> and an unclosed div
  const HTML = '<div dir="ltr">Does it work with &lt;two&gt; batteries?<div>Thanks</div><div><br></div><div><b>Steve</b><br>Ops lead<br><a href="https://www.linkedin.com/in/steve/" target="_blank" style="color:red">LinkedIn</a><img src="https://t.example/open.gif" width="1" height="1"><style>.x{color:red}</style></div><table><tr><td>cell</td></tr></table></div></td></tr></table><script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">bad</a><div>unclosed';
  w.sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, to_addrs, subject, message_id, body_text, body_html, date_hdr, created_at) VALUES ('11111111-1111-4111-8111-111111111111', 't1', 'in', 'support@domain7.example', 'steve@example.com', 'Steve', '[{\"address\":\"support@domain7.example\",\"name\":\"\"}]', 'setup', '<orig-1@example.com>', 'Does it work with <two> batteries?\nThanks\n\n*Steve*\nOps lead\nLinkedIn <https://www.linkedin.com/in/steve/>', ?, '2026-10-22T14:35:09.000Z', '2026-10-22T14:35:10.000Z')").run(HTML);
  w.sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, to_addrs, subject, message_id, body_text, date_hdr, created_at) VALUES ('22222222-2222-4222-8222-222222222222', 't1', 'in', 'support@domain7.example', 'steve@example.com', 'Steve', '[{\"address\":\"support@domain7.example\",\"name\":\"\"}]', 'setup', '<orig-2@example.com>', 'Text only.\nSee https://example.com/x', '2026-10-22T15:00:00.000Z', '2026-10-22T15:00:01.000Z')").run();
  const r = await w.call("/api/messages/11111111-1111-4111-8111-111111111111/reply", { from: "support@domain7.example", text: "Yes, both." });
  const m = w.sends[0] || {}; const h = m.html || "";
  check(r.status === 200 && w.sends.length === 1, `the reply goes (${r.status} ${JSON.stringify(r.body).slice(0, 120)})`);
  check(h.includes("On 2026-10-22 14:35 UTC, Steve wrote:"), "it quotes under the customer's name and time");
  const q = h.slice(h.indexOf("wrote:"), h.indexOf("Have more questions?"));
  check(q.includes('<a href="https://www.linkedin.com/in/steve/">LinkedIn</a>'), "the quote keeps the customer's link, as a link, with only its href");
  check(q.includes("<b>Steve</b>") && q.includes("Does it work with &lt;two&gt; batteries?<div>Thanks</div>"), "and the bold, the paragraphs and the escaped text as written");
  check(!/<img|<style|<script|alert\(1\)|onclick|javascript:|color:red|target=/.test(q), "no picture, style, script, handler, javascript: link or inline style of theirs comes through");
  check(q.includes("<a>bad</a>") && q.includes("<div>unclosed</div>"), "a link with a bad scheme stays text, an unclosed div is closed");
  const n = (x) => (h.match(x) || []).length;
  check(n(/<table\b/g) === n(/<\/table>/g) && n(/<td\b/g) === n(/<\/td>/g) && n(/<tr\b/g) === n(/<\/tr>/g) && h.indexOf("Have more questions?") > h.indexOf("LinkedIn"), `the customer's stray </td></tr></table> did not close the letterhead's own table (tables ${n(/<table\b/g)}/${n(/<\/table>/g)}, cells ${n(/<td\b/g)}/${n(/<\/td>/g)}); the footer follows the quote`);
  check(!/\*Steve\*|LinkedIn &lt;https/.test(h), "nothing of the flattened text part — no asterisks, no bracketed address");
  check(m.headers && m.headers["In-Reply-To"] === "<orig-1@example.com>", `In-Reply-To is the customer's Message-ID (${JSON.stringify(m.headers)})`);
  check(m.text === "Yes, both." && h.includes(">Yes, both.<"), "the answer is the text part and the body of the frame");
  check(m.to && m.to[0] && (m.to[0].email || m.to[0]) === "steve@example.com", `the reply goes to the customer (${JSON.stringify(m.to)})`);
  const r2 = await w.call("/api/messages/22222222-2222-4222-8222-222222222222/reply", { from: "support@domain7.example", text: "Noted." });
  const h2 = (w.sends[1] || {}).html || "";
  check(r2.status === 200 && h2.includes("Text only.<br>See https://example.com/x"), "a text-only original is still quoted escaped, line breaks as <br>");
}
{ // the app learns which domains are branded
  const w = world();
  const r = await w.call("/api/me", null, "GET");
  check(r.status === 200 && Array.isArray(r.body?.brands) && r.body.brands.join() === "domain7.example", `/api/me names the branded domains (${JSON.stringify(r.body?.brands)})`);
}
{ // a broken BRANDS value frames nothing and breaks nothing
  const w = world(); w.env.BRANDS = "{not json";
  const r = await w.call("/api/send", { from: "support@domain7.example", to: ["steve@example.com"], subject: "x", text: "y" });
  check(r.status === 200 && w.sends[0] && w.sends[0].html === undefined, `an unreadable BRANDS sends bare rather than failing (${r.status})`);
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
