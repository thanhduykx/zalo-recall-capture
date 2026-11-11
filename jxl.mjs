/*
 * jxl.mjs — decode Zalo's JPEG-XL (.jxl) cache images to PNG (optionally a thumbnail),
 * using @jsquash wasm codecs. Results are cached on disk keyed by path+mtime+width.
 *
 * jsquash loads its .wasm via fetch(file://…), which Node's undici does not implement,
 * so we shim globalThis.fetch to read file:// URLs from disk (http(s) untouched).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opts) => {
  const s = typeof u === "string" ? u : (u && (u.href || u.url)) || String(u);
  if (s.startsWith("file:")) {
    const buf = fs.readFileSync(fileURLToPath(s));
    return new Response(buf, { status: 200, headers: { "content-type": "application/wasm" } });
  }
  return realFetch(u, opts);
};

let _decode, _encode, _resize, _loading;
async function codecs() {
  if (_decode) return;
  if (!_loading) _loading = (async () => {
    _decode = (await import("@jsquash/jxl/decode.js")).default;
    _encode = (await import("@jsquash/png/encode.js")).default;
    _resize = (await import("@jsquash/resize")).default;
  })();
  await _loading;
}

export function isJxl(file) { return /\.jxl$/i.test(file); }

// Convert a .jxl file to a PNG buffer (thumbnail if maxW given). Cached on disk.
export async function jxlToPng(absPath, cacheDir, maxW) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const st = fs.statSync(absPath);
  const key = crypto.createHash("sha1").update(absPath + "|" + st.mtimeMs + "|" + (maxW || 0)).digest("hex");
  const outPath = path.join(cacheDir, key + ".png");
  if (fs.existsSync(outPath)) return outPath;
  await codecs();
  const buf = fs.readFileSync(absPath);
  let img = await _decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (maxW && img.width > maxW) {
    const h = Math.max(1, Math.round(img.height * (maxW / img.width)));
    img = await _resize(img, { width: maxW, height: h });
  }
  const png = await _encode(img);
  fs.writeFileSync(outPath, Buffer.from(png));
  return outPath;
}
