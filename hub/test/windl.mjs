#!/usr/bin/env node
// The hub's half of the Windows app: its installer and updates (/dl/windows/*, public, read-only, one R2
// prefix), its diagnostics report (/api/applog, session only), and its speed reports filed under "windows". Drives the REAL
// Worker handler with an in-memory R2 and D1.
// Usage: node test/windl.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) {
  const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(/;\s*$/m)) { try { if (stmt.trim()) sq.exec(stmt); } catch (_) {} }
}
const DB = {
  prepare(sql) {
    const mk = (params) => ({
      bind: (...a) => mk(a),
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => Promise.all(xs.map((x) => x.run())),
};
const objects = new Map();
const STORE = {
  async get(k) { const v = objects.get(k); if (v === undefined) return null; const b = Buffer.from(v); return { size: b.length, body: new Response(b).body, text: async () => b.toString() }; },
  async head(k) { const v = objects.get(k); return v === undefined ? null : { size: Buffer.from(v).length }; },
  async put(k, v) { objects.set(k, typeof v === "string" ? v : Buffer.from(v)); },
};

const SRC = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_windl.mjs`;
writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

const SIGN = "test-hmac-key";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (data) => b64u(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(data)));
const exp = Date.now() + 86400000;
const COOKIE = `mh=${exp}.0.${await hmac(`${exp}.0`)}`;
const ENV = { DB, STORE, SESSION_SECRET: SIGN, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
const call = (method, path, { body, cookie = true, ua } = {}) => mod.default.fetch(new Request("https://hub.example" + path, {
  method, headers: { ...(cookie ? { Cookie: COOKIE } : {}), Origin: "https://hub.example", "content-type": "application/json", ...(ua ? { "user-agent": ua } : {}) },
  ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
}), ENV, { waitUntil: (p) => p });

// ---------- 1. downloads: public, read-only, one prefix ----------
const latest = JSON.stringify({ version: "1.0.1", platforms: { "windows-x86_64": { url: "https://hub.example/dl/windows/SheritMail_1.0.1_x64-setup.exe", signature: "sig" } } });
objects.set("dl/windows/latest.json", latest);
objects.set("dl/windows/SheritMail_1.0.1_x64-setup.exe", Buffer.from("MZ installer bytes"));
objects.set("dl/windows/SheritMail-setup.exe", Buffer.from("MZ installer bytes"));
objects.set("raw/secret-mail.eml", "From: someone");
{
  const r = await call("GET", "/dl/windows/latest.json", { cookie: false });
  check(r.status === 200 && (await r.text()) === latest, "latest.json is served without a session");
  check(r.headers.get("cache-control") === "no-cache", "latest.json is revalidated every time (it changes each release)");
  const e = await call("GET", "/dl/windows/SheritMail_1.0.1_x64-setup.exe", { cookie: false });
  check(e.status === 200 && (await e.text()) === "MZ installer bytes", "the versioned installer is served");
  check(/immutable/.test(e.headers.get("cache-control") || ""), "a versioned file is cached for good");
  check(e.headers.get("content-disposition") === 'attachment; filename="SheritMail_1.0.1_x64-setup.exe"', "an installer downloads under its own name");
  check(e.headers.get("content-length") === "18", "content-length is set");
  const u = await call("GET", "/dl/windows/SheritMail-setup.exe", { cookie: false });
  check(u.status === 200 && u.headers.get("cache-control") === "no-cache", "the unversioned installer is served and revalidated");
  const h = await call("HEAD", "/dl/windows/latest.json", { cookie: false });
  check(h.status === 200 && h.headers.get("content-length") === String(latest.length) && (await h.text()) === "", "HEAD answers the size without a body");
  for (const bad of ["/dl/windows/../raw/secret-mail.eml", "/dl/windows/%2e%2e%2fraw%2fsecret-mail.eml", "/dl/windows/.hidden", "/dl/windows/", "/dl/windows/a/b.exe", "/dl/windows/missing.exe"]) {
    const b = await call("GET", bad, { cookie: false });
    check(b.status === 404 || (b.status !== 200 && !(await b.text()).includes("From: someone")), `refused: ${bad} (${b.status})`);
  }
  const p = await call("POST", "/dl/windows/latest.json", { cookie: false, body: "{}" });
  check(p.status !== 200 || objects.get("dl/windows/latest.json") === latest, "a POST cannot write a download");
  check(objects.get("dl/windows/latest.json") === latest, "the download is unchanged");
}

// ---------- 2. diagnostics: session only ----------
{
  const anon = await call("POST", "/api/applog", { cookie: false, body: { device: "windows", log: "x" } });
  check(anon.status === 401, `an applog report needs a session (${anon.status})`);
  check(!objects.has("applog/windows/latest.json"), "nothing stored without a session");
  const bad = await call("POST", "/api/applog", { body: { device: "toaster", log: "x" } });
  check(bad.status === 400, "an unknown device is refused");
  const big = await call("POST", "/api/applog", { body: { device: "windows", log: "x".repeat(120_000) } });
  check(big.status === 413, "an oversized report is refused");
  const ok = await call("POST", "/api/applog", { body: { device: "windows", version: "1.0.0", os: "Windows 11 24H2", log: "2026-10-05T21:00:00Z posted hub|abc" } });
  check(ok.status === 200, "a signed-in report is stored");
  const got = await call("GET", "/api/applog?device=windows");
  const j = await got.json().catch(() => ({}));
  check(got.status === 200 && j.version === "1.0.0" && /posted hub\|abc/.test(j.log) && !!j.received, "the report reads back with the time it was received");
  const anonGet = await call("GET", "/api/applog?device=windows", { cookie: false });
  check(anonGet.status === 401, `reading a report needs a session (${anonGet.status})`);
}

// ---------- 3. speed reports from the Windows app are filed as "windows" ----------
{
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0 SheritWindows/1.0.0";
  const r = await call("POST", "/api/perf", { body: { ua, rows: [] } });
  const j = await r.json().catch(() => ({}));
  check(j.device === "windows", `the Windows app's speed report is filed under windows (${j.device})`);
  const web = await call("POST", "/api/perf", { body: { ua: ua.replace(" SheritWindows/1.0.0", ""), rows: [] } });
  check((await web.json()).device === "web", "Edge on Windows without the app is still web");
  const all = await (await call("GET", "/api/perf")).json();
  check(!!all.windows, "GET /api/perf includes the Windows app");
}

// ---------- 3. the Android app's updates, same shape under /dl/android/ ----------
{
  const al = JSON.stringify({ versionCode: 8, versionName: "1.7", url: "https://mail.yourdomain.example/dl/android/SheritMail-1.7.apk", sha256: "a".repeat(64) });
  objects.set("dl/android/latest.json", al); objects.set("dl/android/SheritMail-1.7.apk", Buffer.from("PK apk bytes"));
  const r = await call("GET", "/dl/android/latest.json", { cookie: false });
  check(r.status === 200 && (await r.text()) === al && r.headers.get("cache-control") === "no-cache", "the Android latest.json is served without a session and revalidated");
  const a = await call("GET", "/dl/android/SheritMail-1.7.apk", { cookie: false });
  check(a.status === 200 && a.headers.get("content-type") === "application/vnd.android.package-archive" && /immutable/.test(a.headers.get("cache-control") || "") && a.headers.get("content-disposition") === 'attachment; filename="SheritMail-1.7.apk"', `a versioned APK is served as an APK, cached for good (${a.headers.get("content-type")}, ${a.headers.get("cache-control")})`);
  for (const bad of ["/dl/android/../raw/secret-mail.eml", "/dl/android/%2e%2e%2fraw%2fsecret-mail.eml", "/dl/linux/latest.json"]) { const b = await call("GET", bad, { cookie: false }); check(b.status !== 200 || !(await b.text()).includes("From: someone"), `refused: ${bad} (${b.status})`); }
}

if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall checks passed");
