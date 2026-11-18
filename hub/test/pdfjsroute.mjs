#!/usr/bin/env node
// EXECUTION test: nothing under /pdfjs/ that reaches the Worker can redirect.
//
// The PDF frame's CSP opens <origin>/pdfjs/ for pdf.js's decoders. CSP3 stops checking the path after a redirect (§6.7.2.8 step 3.6),
// so a redirect under /pdfjs/ would carry the frame's request anywhere on this origin. The decoders are static assets; a request the
// assets do not answer reaches the Worker, which must answer 404 with no Location, whatever the method, path or credentials.
// Usage: node test/pdfjsroute.mjs (exit 1 on any failed check)
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
globalThis.fetch = async (input) => { throw new Error("unexpected fetch " + (typeof input === "string" ? input : input.url)); };
const SRC = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_pdfjsroute_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }
const touched = [];   // any binding the Worker reaches for is a failure: the answer comes before every other route
const trap = (name) => new Proxy({}, { get: (_, k) => { touched.push(name + "." + String(k)); return () => { throw new Error("touched " + name); }; } });
const env = { DB: trap("DB"), STORE: trap("STORE"), CLI_TOKEN: "cli" };
const cases = [
  ["GET", "/pdfjs/6.3.289/nope.js", {}], ["GET", "/pdfjs/", {}], ["GET", "/pdfjs", {}], ["GET", "/pdfjs/6.3.289/jbig2.wasm", {}],
  ["GET", "/pdfjs/6.3.289/..%2f..%2fapi%2fthreads", {}], ["HEAD", "/pdfjs/x", {}], ["POST", "/pdfjs/x", {}], ["OPTIONS", "/pdfjs/x", {}],
  ["GET", "/pdfjs/x", { Authorization: "Bearer cli" }], ["GET", "/pdfjs/x", { Cookie: "mh=anything" }],
];
for (const [method, path, headers] of cases) {
  const r = await mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers }), env, { waitUntil: () => {} });
  check(r.status === 404 && !r.headers.get("location") && !r.headers.get("set-cookie") && !r.headers.get("access-control-allow-origin"),
    `${method} ${path}${Object.keys(headers).length ? " with " + Object.keys(headers)[0] : ""}: 404, no Location, no cookie, no CORS (${r.status}${r.headers.get("location") ? " -> " + r.headers.get("location") : ""})`);
}
check(touched.length === 0, `no binding was touched on the way (${touched.slice(0, 3)})`);
console.log(fails.length ? `${fails.length} failed` : "all /pdfjs/ route checks passed");
process.exit(fails.length ? 1 : 0);
