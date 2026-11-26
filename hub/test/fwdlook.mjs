#!/usr/bin/env node
// A forward looks like the mail you got: the hub's own forward (a hub mail sent from a hub address, the CLI's mail
// forward too) carries the original's HTML as its body, the way Gmail forwards, with the original's <style> moved to the head and no
// quote bar; its text part keeps each link's address beside its words; its inline pictures go as inline parts under their Content-ID; and
// a forward whose block was edited in the compose box (as_typed) goes as that text, the original's files still with it.
// The real Worker on real migrations and SQLite, its sends captured from the EMAIL binding.
// Usage: node test/fwdlook.mjs (exit 1 on any failed check)
// CONTROL: FWDLOOK_SRC=<an index.js from before the change> node test/fwdlook.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import PostalMime from "postal-mime";
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
const SRC = readFileSync(process.env.FWDLOOK_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_fwdlook_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }


const RICH = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>.btn{background:#111;color:#fff;padding:12px 24px;border-radius:6px}</style></head>
<body bgcolor="#f4f1ea" style="margin:0"><table width="600"><tr><td><img src="cid:logo1" alt="Lord of the Lanes" width="120">
<h1>Join us at the hall</h1><p>Sign up for each show you are attending.</p>
<a class="btn" href="https://tickets.example/signup?show=42&amp;src=mail">Sign Up</a> <a href="https://tickets.example/app">View in app</a>
<script>alert(1)</script></td></tr></table></body></html>`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sq = buildDb(); const objs = new Map([["att/logo1", PNG], ["att/menu", new TextEncoder().encode("%PDF-1.4 menu")]]); const sends = [];
sq.prepare("INSERT INTO identities (email, display_name, is_active, domain) VALUES ('sam@hub.example', 'Sam', 1, 'hub.example')").run();
sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread) VALUES ('t1', 'join us', '[]', '2026-11-26T02:37:25Z', 1, 'inbox', 0)").run();
const MID = "33333333-3333-4333-8333-333333333333";
sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, to_addrs, subject, message_id, body_text, body_html, date_hdr, created_at) VALUES (?, 't1', 'in', 'sam@hub.example', 'noreply@venue.example', 'The Venue', '[{\"address\":\"sam@hub.example\"}]', 'Join us', '<v1@venue.example>', NULL, ?, 'Wed, 25 Nov 2026 19:37:25 -0700', '2026-11-26T02:37:25Z')").run(MID, RICH);
sq.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition) VALUES ('a1', ?, 'logo.png', 'image/png', 12, 'att/logo1', '<logo1>', 'inline')").run(MID);
sq.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition) VALUES ('a2', ?, 'menu.pdf', 'application/pdf', 13, 'att/menu', NULL, 'attachment')").run(MID);
const env = { DB: d1(sq), CLI_TOKEN: "cli-token", DOMAINS: "hub.example",
  STORE: { put: async (k, v) => { objs.set(k, v); }, get: async (k) => (objs.has(k) ? { body: objs.get(k), arrayBuffer: async () => objs.get(k).buffer.slice(0) } : null), list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); }, head: async () => null },
  EMAIL: { send: async (m) => { sends.push(m); return { messageId: `<p${sends.length}@hub.test>` }; } } };
const call = async (path, body) => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { method: "POST", headers: { Authorization: "Bearer cli-token", "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: () => {} }); return { status: r.status, body: await r.json().catch(() => null) }; };
// What the recipient's mail app reads: the raw message the EMAIL binding was given, parsed as the hub parses mail (postal-mime).
const parsed = async (x) => (x && x.raw ? await PostalMime.parse(x.raw) : {});
const att = (m) => (m.attachments || []).map((a) => ({ name: a.filename, type: a.mimeType, inline: a.disposition === "inline", cid: a.contentId ? String(a.contentId).replace(/^<|>$/g, "") : null }));
try {
  const r = await call(`/api/messages/${MID}/forward`, { from: "sam@hub.example", to: ["pat@friend.example"], text: "This one is for you two" });
  const m = await parsed(sends[0]), html = String(m.html || ""), text = String(m.text || "");
  check(r.status === 200 && sends.length === 1, `the forward goes (${r.status} ${JSON.stringify(r.body).slice(0, 80)})`);
  check(html.includes('href="https://tickets.example/signup?show=42&amp;src=mail"') && html.includes(">Sign Up</a>") && html.includes('href="https://tickets.example/app"'), "its HTML carries the original's buttons with their links");
  check(html.indexOf("<style>.btn") > -1 && html.indexOf("<style>.btn") < html.indexOf("<body") && html.includes('style="background-color:#f4f1ea;margin:0"'), "the original's style is in the head, its body's colour on the wrapper");
  check(html.includes("---------- Forwarded message ---------<br>From: The Venue &lt;noreply@venue.example&gt;") && html.includes("This one is for you two") && !/border-left:2px solid #ccc/.test(html), "under the note and a Gmail-style header, with no quote bar");
  check(!/<script/i.test(html), "the original's script does not go along");
  check(text.includes("Sign Up <https://tickets.example/signup?show=42&src=mail>") && text.includes("View in app <https://tickets.example/app>") && text.startsWith("This one is for you two"), `its text part keeps each link's address (${JSON.stringify(text.slice(0, 260))})`);
  const a0 = att(m);
  check(a0.some((x) => x.name === "logo.png" && x.inline && x.cid === "logo1") && a0.some((x) => x.name === "menu.pdf" && !x.inline), `the inline picture goes inline under its Content-ID, the file as a file (${JSON.stringify(a0)})`);
  const typed = "This one is for you\n\n---------- Forwarded message ----------\nFrom: The Venue\n\nSign up for each show (my seat number removed)";
  const r2 = await call(`/api/messages/${MID}/forward`, { from: "sam@hub.example", to: ["pat@friend.example"], text: typed, as_typed: true });
  const m2 = await parsed(sends[1]);
  const h2 = String(m2.html || "");
  check(r2.status === 200 && String(m2.text || "").trim() === typed && !/tickets\.example|Join us at the hall|<style/.test(h2), `a forward whose block was edited goes as the text typed, nothing of the original's HTML (${JSON.stringify((m2.text || "").slice(0, 60))})`);
  check(att(m2).some((x) => x.name === "menu.pdf") && !att(m2).some((x) => x.inline) && !/cid:logo1/.test(h2), `and the original's file still goes with it, not the pictures of its body (${JSON.stringify(att(m2))})`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall forward-look checks passed");
process.exit(fails.length ? 1 : 0);
