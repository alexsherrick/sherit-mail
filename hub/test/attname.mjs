#!/usr/bin/env node
// EXECUTION test for GET /api/gmail/att/...: the real Worker, real migrations, Google stubbed at globalThis.fetch.
//
// A PDF attachment downloaded under a broken name. The bytes were right; the
// name was not: the route answered `content-disposition: attachment` with no filename, so the Mac app saved the 99,487-byte PDF as
// "ANGjdJ_0000…" (the Gmail attachment id) with no extension. This pins that the route names the file, in a form that survives a
// hostile name (quotes, CR/LF, non-ASCII), and that nothing about the bytes or the image handling changed.
// Usage: node test/attname.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const statements = (sql) => { const out = []; let buf = "";
  for (const part of sql.split(";")) { buf += part + ";"; const open = (buf.match(/\bBEGIN\b/gi) || []).length, close = (buf.match(/\bEND\b/gi) || []).length; if (open === close) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } }
  const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) {
  const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).map((l) => l.replace(/\s--\s.*$/, "")).join("\n");
  for (const stmt of statements(sql)) { try { sq.exec(stmt); } catch (_) {} }
}
const d1 = { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) ?? null, run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }) }); return mk([]); }, batch: async (xs) => Promise.all(xs.map((x) => x.run())) };

// a connected Gmail account whose refresh token is sealed the way the Worker seals it (raw key, AAD = the address)
const KEY = crypto.getRandomValues(new Uint8Array(32)); const ACCT = "me@gmail.com";
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ACCT) }, await crypto.subtle.importKey("raw", KEY, { name: "AES-GCM" }, false, ["encrypt"]), new TextEncoder().encode("refresh-token")));
sq.prepare("INSERT INTO gmail_accounts (email, status, refresh_token_enc, refresh_iv, created_at) VALUES (?, 'active', ?, ?, '2026-10-01')").run(ACCT, Buffer.from(ct).toString("base64"), Buffer.from(iv).toString("base64"));

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(crypto.getRandomValues(new Uint8Array(4000))), Buffer.from("\n%%EOF\n")]);
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "oauth2.googleapis.com") return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
  if (u.hostname === "gmail.googleapis.com") return new Response(JSON.stringify({ size: PDF.length, data: PDF.toString("base64url") }));
  throw new Error("unexpected fetch " + u.href);
};
const SRC = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_attname_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }
const env = { DB: d1, CLI_TOKEN: "cli", GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "s", GMAIL_TOKEN_KEY: Buffer.from(KEY).toString("base64") };
const get = async (q) => { const r = await mod.default.fetch(new Request(`https://hub.example/api/gmail/att/${encodeURIComponent(ACCT)}/msg1/att1${q}`, { headers: { Authorization: "Bearer cli" } }), env, { waitUntil: () => {} });
  return { status: r.status, cd: r.headers.get("content-disposition") || "", ct: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) }; };

{ // the broken-name case
  const r = await get("?mime=application%2Fpdf&name=" + encodeURIComponent("02 - Oct - Acme Q3 2026 Update.pdf"));
  check(r.status === 200 && r.body.equals(PDF), `the bytes are the attachment's, unchanged (${r.status}, ${r.body.length} bytes)`);
  check(r.ct === "application/octet-stream" && r.cd.startsWith("attachment;"), `a PDF is still a download, never rendered in the hub's origin (${r.ct}; ${r.cd.split(";")[0]})`);
  check(r.cd.includes(`filename="02_-_Oct_-_Acme_Q3_2026_Update.pdf"`) && r.cd.includes("filename*=UTF-8''02%20-%20Oct%20-%20Acme%20Q3%202026%20Update.pdf"), `it carries the file's name, plain and UTF-8 (${r.cd})`);
}
{ // a hostile name cannot add a header or break out of the quotes
  const r = await get("?name=" + encodeURIComponent('evil"\r\nSet-Cookie: x=1; a\'(b)*.pdf'));
  check(!/[\r\n]/.test(r.cd) && !r.cd.includes("Set-Cookie: x") && (r.cd.match(/"/g) || []).length === 2, `quotes and CR/LF in a name stay inside the value (${JSON.stringify(r.cd)})`);
  const r2 = await get("?name=" + encodeURIComponent("Übersicht — Q3 €.pdf"));
  check(r2.cd.includes("filename*=UTF-8''%C3%9Cbersicht%20%E2%80%94%20Q3%20%E2%82%AC.pdf"), `a non-ASCII name survives in filename* (${r2.cd})`);
}
{ // unchanged: no name still downloads, an image is still inline
  const r = await get("?mime=application%2Fpdf");
  check(r.cd === "attachment", `with no name the old answer is unchanged (${r.cd})`);
  const r2 = await get("?mime=image%2Fpng&name=logo.png");
  check(r2.ct === "image/png" && r2.cd.startsWith("inline;"), `an inline image stays inline (${r2.ct}; ${r2.cd})`);
}
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall attachment-name checks passed");
