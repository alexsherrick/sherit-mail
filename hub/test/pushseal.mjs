#!/usr/bin/env node
// EXECUTION test: push previews sealed for the phone. FCM carries a data message through Google's servers as it is
// given, so each new mail's sender, subject and first 160 characters were readable there: the domain mail kept off Gmail included.
// The Android app (1.13) registers a 256-bit key with its token; the hub seals every push with it (AES-256-GCM over deflate-raw JSON).
// Checks, on the real Worker over the real migrations, with Google's token and FCM endpoints stubbed:
//  - a registration's key is stored (and a malformed one is not); the hub says the phone's pushes are sealed;
//  - a mail push to that phone carries `e` and `n`, no `p`, and neither the sender, the subject nor the text appear anywhere in what
//  goes to Google; opened with the key it is the whole payload;
//  - a phone that registered no key gets the sender only: no subject, no text;
//  - a 40-key dismissal (the largest batch the hub sends) and a mail push carrying 20 clears with a 320-character emoji body stay
//  under FCM's 4,096 bytes sealed; one over the limit goes without its clears, and they stay owed;
//  - the Android app's own PushSeal.kt, compiled and run on a JVM, opens what the hub sealed, and refuses another key's.
// CONTROL: PUSHSEAL_SRC=<index.js before the change> sends the preview readable to every phone.
// Usage: node test/pushseal.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createDecipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";

const HUB = new URL("../", import.meta.url).pathname;
const CONTROL = !!process.env.PUSHSEAL_SRC;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq) => { const run = (sql, p, kind) => { const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => Promise.all(xs.map((x) => x.run())) }; };
let SRC = readFileSync(process.env.PUSHSEAL_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const want = ["sendFcm", "fcmData"].filter((n) => new RegExp(`(async )?function ${n}\\(`).test(SRC));
SRC += `\nexport { ${want.join(", ")} };\n`;
const tmp = `${HUB}test/_pushseal_worker.mjs`; writeFileSync(tmp, SRC); const M = await import(tmp).finally(() => unlinkSync(tmp));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = { project_id: "sherit-test", client_email: "fcm@sherit-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
const sq = buildDb(); const env = { DB: d1(sq), FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", GMAIL_TOKEN_KEY: "k", CLI_TOKEN: "test-token", SESSION_SECRET: "s", FCM_SERVICE_ACCOUNT: JSON.stringify(sa) };
const call = (method, path, body) => M.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil() {} });
const realFetch = globalThis.fetch; const sends = [];
globalThis.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "fcm-at", expires_in: 3600 }), { status: 200 });
  if (u.startsWith("https://fcm.googleapis.com/v1/projects/sherit-test/messages:send")) { sends.push({ raw: String(o.body), m: JSON.parse(o.body).message }); return new Response(JSON.stringify({ name: "projects/sherit-test/messages/1" }), { status: 200 }); }
  return realFetch(url, o);
};
const b64u = (b) => Buffer.from(b).toString("base64url");
const open = (keyB64, sealed) => { try { const k = Buffer.from(keyB64, "base64url"), raw = Buffer.from(sealed, "base64url"); const d = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12)); d.setAAD(Buffer.from("sherit-push-v1")); d.setAuthTag(raw.subarray(raw.length - 16)); return inflateRawSync(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()])).toString("utf8"); } catch (_) { return null; } };
const KEY = b64u(randomBytes(32)), PHONE = "sealed-phone-token-aaaaaaaaaaaaaaaaaaaa", OLD = "plain-phone-token-bbbbbbbbbbbbbbbbbbbbb";
const MAIL = { kind: "hub", account: "hub", thread: "11111111-2222-3333-4444-555555555555", priority: false, title: "Jason Whitfield", body: "Confidential: merger terms\nThe Q4 numbers for the Aurora deal are attached, do not forward", url: "/?account=hub&thread=11111111-2222-3333-4444-555555555555" };
const SECRETS = /Jason|Whitfield|merger|Aurora|Q4 numbers/;

const reg = await call("POST", "/api/push/fcm", { token: PHONE, ua: "SheritAndroid/1.13", key: KEY });
await call("POST", "/api/push/fcm", { token: OLD, ua: "SheritAndroid/1.12" });
await call("POST", "/api/push/fcm", { token: "badkey-phone-token-ccccccccccccccccccc", ua: "x", key: "not-a-key" });
const rows = Object.fromEntries(sq.prepare("SELECT token, push_key FROM fcm_devices").all().map((r) => [r.token, r.push_key ?? null]));
if (!CONTROL) {
  const rj = await reg.json();
  check(rows[PHONE] === KEY && rows[OLD] === null && rows["badkey-phone-token-ccccccccccccccccccc"] === null && rj.sealed === true, `a registration's key is stored, none for an app without one or a malformed one; the hub answers sealed (${JSON.stringify(rj)})`);
}
sq.prepare("DELETE FROM fcm_devices WHERE token LIKE 'badkey%'").run();
await M.sendFcm(env, { ...MAIL });
const toPhone = sends.find((s) => s.m.token === PHONE), toOld = sends.find((s) => s.m.token === OLD);
if (CONTROL) check(toPhone && SECRETS.test(toPhone.raw), `CONTROL — the hub before the change sends the sender, subject and text readable to Google (${(toPhone?.raw || "").slice(0, 120)})`);
else {
  check(!!toPhone && toPhone.m.data.e && toPhone.m.data.n === "1" && !("p" in toPhone.m.data) && !SECRETS.test(toPhone.raw), `a mail push to a phone with a key is sealed: e and n only, no sender, subject or text in what goes to Google (${Object.keys(toPhone?.m.data || {})}, ${toPhone?.raw.length} bytes)`);
  const opened = JSON.parse(open(KEY, toPhone.m.data.e) || "{}");
  check(opened.title === MAIL.title && opened.body === MAIL.body && opened.thread === MAIL.thread && opened.kind === "hub" && Array.isArray(opened.acts), `… opened with the phone's key it is the whole payload (${opened.title} / ${String(opened.body).slice(0, 30)}…)`);
  check(open(b64u(randomBytes(32)), toPhone.m.data.e) === null, "… and another key does not open it");
  const p = JSON.parse(toOld?.m.data.p || "{}");
  check(p.title === MAIL.title && p.body === "" && !/merger|Aurora/.test(toOld.raw), `a phone that registered no key gets the sender only, no subject or text (${JSON.stringify({ title: p.title, body: p.body })})`);
  // sizes: the largest batches the hub sends
  const keyOf = (i) => `sam.owner.sxsw@gmail.com|${randomBytes(8).toString("hex")}${i}`;
  const d = { token: PHONE, push_key: KEY };
  const dis = await M.fcmData(d, { kind: "dismiss", dismiss: Array.from({ length: 40 }, (_, i) => ({ k: keyOf(i), at: Date.now() - i * 1000 })) });
  const emoji = "🚀".repeat(160);
  const big = await M.fcmData(d, { ...MAIL, title: "📈".repeat(60), body: emoji + "\n" + emoji, acts: ["done", "read", "quiet"], dismiss: Array.from({ length: 20 }, (_, i) => ({ k: keyOf(i), at: Date.now() })) });
  const size = (x) => Buffer.byteLength(JSON.stringify(x));
  check(size(dis) < 3900 && JSON.parse(open(KEY, dis.e)).dismiss.length === 40, `a 40-key dismissal sealed is ${size(dis)} bytes, under FCM's 4,096 (plain it was ${Buffer.byteLength(JSON.stringify({ kind: "dismiss", dismiss: JSON.parse(open(KEY, dis.e)).dismiss }))})`);
  check(size(big) < 3900 && !big.dropped && JSON.parse(open(KEY, big.e)).dismiss.length === 20, `a mail push with 20 clears and a 320-character emoji body sealed is ${size(big)} bytes, clears kept`);
  const over = await M.fcmData(d, { ...MAIL, dismiss: Array.from({ length: 400 }, (_, i) => ({ k: keyOf(i) + randomBytes(24).toString("hex"), at: Date.now() - i })) });
  check(over.dropped && size(over) < 3900 && !JSON.parse(open(KEY, over.e)).dismiss, `one over the limit goes without its clears (${size(over)} bytes; dropped ${over.dropped})`);
  // the Android app's own file, on a JVM
  const KT = HUB + "../android/app/src/main/java/com/sheritlabs/mail/PushSeal.kt";
  const KOTLINC = "/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc", JAVA_HOME = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  if (existsSync(KOTLINC) && existsSync(KT)) {
    const dir = mkdtempSync(tmpdir() + "/pushseal-");
    writeFileSync(dir + "/Check.kt", 'import com.sheritlabs.mail.PushSeal\nfun main(a: Array<String>) { for (l in java.io.File(a[0]).readLines()) { val (k, s) = l.split("\\t"); val o = PushSeal.open(k, s); println(if (o == null) "NULL" else java.util.Base64.getEncoder().encodeToString(o.toByteArray(Charsets.UTF_8))) } }\n');
    const vec = [[KEY, toPhone.m.data.e], [KEY, dis.e], [KEY, big.e], [b64u(randomBytes(32)), toPhone.m.data.e], [KEY, toPhone.m.data.e.slice(0, -4) + "AAAA"]];
    writeFileSync(dir + "/v.tsv", vec.map((v) => v.join("\t")).join("\n"));
    const envJ = { ...process.env, JAVA_HOME, PATH: `${JAVA_HOME}/bin:${process.env.PATH}` };
    let out = [];
    try {
      execFileSync("bash", [KOTLINC, KT, dir + "/Check.kt", "-include-runtime", "-d", dir + "/check.jar"], { env: envJ, stdio: "pipe" });   // the script ships without its execute bit
      out = execFileSync(`${JAVA_HOME}/bin/java`, ["-jar", dir + "/check.jar", dir + "/v.tsv"], { env: envJ }).toString().trim().split("\n");
    } catch (e) { out = ["ERROR " + String(e.stderr || e.message).slice(0, 300)]; }
    const dec = (x) => (x && x !== "NULL" && !x.startsWith("ERROR") ? Buffer.from(x, "base64").toString("utf8") : x);
    check(dec(out[0]) === open(KEY, toPhone.m.data.e) && dec(out[1]) === open(KEY, dis.e) && dec(out[2]) === open(KEY, big.e), `the Android app's PushSeal.kt, on a JVM, opens the mail push, the 40-key dismissal and the emoji push exactly as sealed (${String(out[0]).slice(0, 40)}…)`);
    check(out[3] === "NULL" && out[4] === "NULL", `… and refuses another key's and a damaged one (${out[3]}, ${out[4]})`);
  } else check(false, "kotlinc or PushSeal.kt not found: the Android side was not checked");
}
globalThis.fetch = realFetch;
console.log(fails.length ? `${fails.length} failed` : "all sealed-push checks passed");
process.exit(fails.length ? 1 : 0);
