#!/usr/bin/env node
// The hub's arrival prefetch reads a mail's pictures the way the viewer does: an attribute written straight after the
// closing quote of the one before it (Revinate: `border="0"src="https://img.revinate.com/…"alt="Hotel Logo"`) is read. Over
// test/glued.html (a hotel newsletter's ten <img> tags verbatim, plus a glued td background, img srcset, <source> srcset with a tracker
// candidate and a tracker td background) prefetchImageUrls lists the nine pictures and the four others, and no sendgrid.net URL.
// CONTROL: GLUED_SRC=<the Worker before the change> lists none of the nine. Usage: node test/glued.mjs (exit 1 on any failure)
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const HUB = new URL("../", import.meta.url).pathname;
const fails = []; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const SRC = readFileSync(process.env.GLUED_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_glued_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const html = readFileSync(HUB + "test/glued.html", "utf8");
const urls = mod.prefetchImageUrls(html);
const pics = [...new Set([...html.matchAll(/https:\/\/img\.revinate\.com\/image\/upload\/[a-z0-9]+\.(?:png|gif|jpg)/g)].map((m) => m[0]))];
const ace = pics.filter((u) => !/\/(bg|a|a2|c)\.png$/.test(u));
check(ace.length === 9 && pics.length === 13, `the fixture holds the nine hotel pictures and four more (${ace.length}, ${pics.length})`);
check(ace.every((u) => urls.includes(u)), `prefetch lists all nine (${ace.filter((u) => urls.includes(u)).length} of 9)`);
check(pics.every((u) => urls.includes(u)), `and the glued td background, the srcset candidates and the <source> candidate (${pics.filter((u) => urls.includes(u)).length} of ${pics.length})`);
check(!urls.some((u) => /sendgrid\.net/.test(u)), `and no sendgrid.net URL (${urls.filter((u) => /sendgrid/.test(u)).length})`);
check(urls.length === pics.length, `nothing else (${urls.length} listed)`);
console.log(fails.length ? `${fails.length} failed` : "all glued checks passed"); process.exit(fails.length ? 1 : 0);
