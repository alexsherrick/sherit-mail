// The picture shrinker's container. POST /shrink with a stored picture's bytes answers it as WebP: turned upright
// (EXIF), every frame of an animation kept, at most ?w= pixels wide (default 1600, never enlarged), quality ?q= (default 82). The
// container has no internet; it only sees what the mailhub-shrink Worker sends it. Any GET answers 200 for the startup health check.
import http from "node:http";
import sharp from "sharp";

sharp.concurrency(1);   // one picture at a time on a 1/4 vCPU instance
sharp.cache(false);     // nothing is shrunk twice, so libvips' cache only holds memory
const MAX_IN = 20 * 1024 * 1024;   // the hub keeps nothing over 16 MiB (index.js IMG_MAX)
// sharp's own default ceiling (0x3FFF squared). One newsletter's 180-frame GIF is 201 million pixels and peaked at 293 MiB in this image; libvips
// streams most formats. A picture past the ceiling, or one sharp refuses, is answered 422 and left as sent; if the process dies instead
// (the 1 GiB exhausted), the picture is tried again and marked failed after three tries.
const PIXELS = 268_402_689;
// More frames than this, or more pixels across all frames than PIXELS, is refused from the header before any decoding; and sharp stops
// any one picture after TIMEOUT_S, so a crafted one costs at most that. That newsletter's GIF has 180 frames and took
// ~58 s on the `basic` instance.
const MAX_FRAMES = 600, TIMEOUT_S = 120;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://shrinker");
  if (req.method === "GET") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (req.method !== "POST" || u.pathname !== "/shrink") { res.writeHead(404); return res.end(); }
  const parts = []; let n = 0;
  // Refused mid-body, the connection is closed with the answer: left open with the rest of the upload unread, the next request sent on
  // it waited for ever (test/shrink.mjs).
  for await (const c of req) { n += c.length; if (n > MAX_IN) { res.writeHead(413, { connection: "close" }); res.end("too large"); req.destroy(); return; } parts.push(c); }
  const w = Math.min(4000, Math.max(100, Number(u.searchParams.get("w")) || 1600));
  const q = Math.min(95, Math.max(40, Number(u.searchParams.get("q")) || 82));
  try {
    const input = Buffer.concat(parts);
    const meta = await sharp(input, { animated: true, limitInputPixels: PIXELS }).metadata();
    const pages = meta.pages || 1, pageH = meta.pageHeight || meta.height;
    if (pages > MAX_FRAMES || meta.width * pageH * pages > PIXELS) { res.writeHead(422, { "content-type": "text/plain" }); return res.end(`refused: ${pages} frames of ${meta.width}x${pageH}`); }
    let img = sharp(input, { animated: true, limitInputPixels: PIXELS }).timeout({ seconds: TIMEOUT_S });
    if ((meta.pages || 1) === 1) img = img.rotate();   // EXIF orientation; an animation carries none
    const out = await img.resize({ width: w, withoutEnlargement: true }).webp({ quality: q, effort: 4 }).toBuffer();
    res.writeHead(200, { "content-type": "image/webp", "x-frames": String(meta.pages || 1), "x-in": `${meta.width}x${meta.pageHeight || meta.height}` });
    res.end(out);
  } catch (e) {
    res.writeHead(422, { "content-type": "text/plain" }); res.end(String(e?.message || e).slice(0, 300));
  }
});
server.listen(Number(process.env.PORT) || 8080);
// node is PID 1 here, and PID 1 can only be ended by a signal it has a handler for (kill(2)); node's own SIGTERM handler resets itself
// to the default action and re-raises, which the kernel ignores for PID 1. The mailhub-shrink Worker's stop() is that SIGTERM, and
// without this listener one instance ran nine days after its batches had ended. The process holds nothing worth
// keeping: the Worker stops it only between pictures.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); process.exit(0); });
