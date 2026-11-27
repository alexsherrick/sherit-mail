#!/usr/bin/env node
// A logo's fingerprint with the real WebAssembly (resvg, logodec.wasm) on pictures made by sharp:
//  - a copy a copier would serve matches its original (pHash within 8 bits, colours within 24): the same picture as JPEG, WebP, shrunk
//  to half and padded, inside an ICO as a PNG and as a BMP, and drawn from its SVG;
//  - a different logo does not; a blank picture is flat (sd under 12) and never used; bytes that are no picture give null;
//  - the mailhub-img Worker answers POST /logo-mark with it, 413 over 512 KB, 404 for anything else.
// Usage: node test/logomark.mjs (exit 1 on any failed check)
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
const HUB = new URL("../", import.meta.url).pathname;
const sharp = createRequire(HUB + "shrink/container/package.json")("sharp");
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const wasm = (p) => `new WebAssembly.Module((await import("node:fs")).readFileSync(${JSON.stringify(p)}))`;
const src = readFileSync(HUB + "img/src/logomark.js", "utf8")
  .replace('import RESVG_WASM from "@resvg/resvg-wasm/index_bg.wasm";', `const RESVG_WASM = ${wasm(HUB + "node_modules/@resvg/resvg-wasm/index_bg.wasm")};`)
  .replace('import LOGODEC_WASM from "../wasm/logodec.wasm";', `const LOGODEC_WASM = ${wasm(HUB + "img/wasm/logodec.wasm")};`);
const tmpMark = HUB + "test/_logomark.mjs"; writeFileSync(tmpMark, src);
const imgSrc = readFileSync(HUB + "img/src/index.js", "utf8")
  .replace('import SHRINK_WASM from "../wasm/shrink.wasm";', `const SHRINK_WASM = ${wasm(HUB + "img/wasm/shrink.wasm")};`)
  .replace('import { logoMark } from "./logomark.js";', 'import { logoMark } from "./_logomark.mjs";');
const tmpImg = HUB + "test/_logomark_img.mjs"; writeFileSync(tmpImg, imgSrc);
let M, W; try { M = await import(tmpMark); W = await import(tmpImg); } finally { unlinkSync(tmpMark); unlinkSync(tmpImg); }

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="10" y="10" width="100" height="100" rx="22" fill="#0b5fff"/><circle cx="60" cy="52" r="24" fill="#fff"/><rect x="30" y="84" width="60" height="12" rx="6" fill="#ffd400"/></svg>';
const OTHER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><polygon points="60,8 112,110 8,110" fill="#1a7f37"/><rect x="48" y="60" width="24" height="40" fill="#fff"/></svg>';
const png = await sharp(Buffer.from(LOGO), { density: 200 }).resize(256, 256).png().toBuffer();
const raw = await sharp(png).resize(64, 64).ensureAlpha().raw().toBuffer();
const ico = (entry, w, h) => { const b = Buffer.alloc(22 + entry.length); b.writeUInt16LE(0, 0); b.writeUInt16LE(1, 2); b.writeUInt16LE(1, 4); b[6] = w & 255; b[7] = h & 255; b.writeUInt16LE(1, 10); b.writeUInt16LE(32, 12); b.writeUInt32LE(entry.length, 14); b.writeUInt32LE(22, 18); entry.copy(b, 22); return b; };
const bmp = (() => { const w = 64, h = 64, hdr = Buffer.alloc(40); hdr.writeUInt32LE(40, 0); hdr.writeInt32LE(w, 4); hdr.writeInt32LE(h * 2, 8); hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14);
  const px = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = ((h - 1 - y) * w + x) * 4; px[d] = raw[s + 2]; px[d + 1] = raw[s + 1]; px[d + 2] = raw[s]; px[d + 3] = raw[s + 3]; }
  return Buffer.concat([hdr, px, Buffer.alloc(Math.ceil(w / 32) * 4 * h)]); })();
const copies = {
  jpeg: await sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer(),
  webp: await sharp(png).webp({ quality: 75 }).toBuffer(),
  "half and padded": await sharp(png).resize(128, 128).extend({ top: 16, bottom: 16, left: 16, right: 16, background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer(),
  "ICO with a PNG": ico(await sharp(png).resize(64, 64).png().toBuffer(), 64, 64),
  "ICO with a BMP": ico(bmp, 64, 64),
  svg: Buffer.from(LOGO),
};
const pop = (a, b) => { let n = 0, x = BigInt("0x" + a) ^ BigInt("0x" + b); while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
const col = (a, b) => { let s = 0; for (let i = 0; i < 96; i += 2) s += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)); return s / 48; };
try {
  const o = await M.logoMark(new Uint8Array(png));
  check(o && /^[0-9a-f]{16}$/.test(o.ph) && /^[0-9a-f]{96}$/.test(o.sig) && o.sd >= 12, `a logo has a fingerprint (${JSON.stringify(o && { ph: o.ph, sd: o.sd })})`);
  for (const [k, b] of Object.entries(copies)) {
    const c = await M.logoMark(new Uint8Array(b)); const d = c ? pop(o.ph, c.ph) : 99, cd = c ? col(o.sig, c.sig) : 999;
    check(c && d <= 8 && cd <= 24, `a copy (${k}) matches its original (${d} bits, colours ${cd.toFixed(1)})`);
  }
  const x = await M.logoMark(new Uint8Array(await sharp(Buffer.from(OTHER), { density: 200 }).resize(256, 256).png().toBuffer()));
  check(x && (pop(o.ph, x.ph) > 8 || col(o.sig, x.sig) > 24), `a different logo does not (${x && pop(o.ph, x.ph)} bits, colours ${x && col(o.sig, x.sig).toFixed(1)})`);
  const blank = await M.logoMark(new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer()));
  check(blank && blank.sd < 12, `a blank picture is flat, never used (sd ${blank && blank.sd})`);
  check((await M.logoMark(new TextEncoder().encode("<html>not a picture</html>"))) === null, "bytes that are no picture give null");
  const post = (body) => W.default.fetch(new Request("https://mailhub-img/logo-mark", { method: "POST", body }));
  const r = await post(png), j = await r.json();
  const big = await post(new Uint8Array(600 * 1024)), other = await W.default.fetch(new Request("https://mailhub-img/"));
  check(r.status === 200 && j.ph === o.ph && big.status === 413 && other.status === 404, `the Worker answers POST /logo-mark (${r.status}, ${big.status}, ${other.status})`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall logo fingerprint checks passed");
process.exit(fails.length ? 1 : 0);
