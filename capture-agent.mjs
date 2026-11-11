/*
 * capture-agent.mjs — connects to a locally-running Zalo (Electron) over the
 * Chrome DevTools Protocol, injects hook.js into every renderer page, receives
 * captured message/recall records via a CDP binding, persists them, and serves
 * a small viewer at http://localhost:9333.
 *
 * No external dependencies: uses Node's global `fetch`, `WebSocket`, and `http`.
 * Requires Zalo started with:  --remote-debugging-port=9222 --remote-allow-origins=*
 *
 * Scope: the signed-in user's own account on this machine. Data stays local.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { jxlToPng, isJxl } from "./jxl.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
// Port resolution: env var wins, then the port published by start/autostart.ps1, then 9222.
// Scripts move off 9222 when another app squats it, so the file must be honoured here too.
function resolveCdpPort() {
  const env = Number(process.env.ZCAP_CDP_PORT || 0);
  if (env) return env;
  try {
    const f = Number(fs_readPortFile());
    if (f) return f;
  } catch {}
  return 9222;
}
function fs_readPortFile() {
  return fs.readFileSync(path.join(__dir, "data", "cdp-port.txt"), "utf8").trim();
}
const CDP_PORT = resolveCdpPort();
const VIEWER_PORT = Number(process.env.ZCAP_VIEWER_PORT || 9333);
const DATA_DIR = path.join(__dir, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const MESSAGES_LOG = path.join(DATA_DIR, "messages.jsonl");
const RECALLS_LOG = path.join(DATA_DIR, "recalls.jsonl");
const MEDIA_DIR = path.join(DATA_DIR, "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const HOOK_SRC = fs.readFileSync(path.join(__dir, "hook.js"), "utf8");
const downloadedMedia = new Set();

// ---------- Zalo media cache (existing files on disk; works offline) --------
const MEDIA_CACHE_ROOT = path.join(process.env.APPDATA || "", "ZaloData", "media");
const PNG_CACHE = path.join(DATA_DIR, "_pngcache");
fs.mkdirSync(PNG_CACHE, { recursive: true });
const IMG_EXT = new Set([".jxl", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VID_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
function kindOf(ext) { if (IMG_EXT.has(ext)) return "image"; if (VID_EXT.has(ext)) return "video"; return "file"; }

let mediaIndex = [];       // [{rel, ext, kind, size, mtime}]
let mediaIndexAt = 0;
function buildMediaIndex() {
  const out = [];
  const stack = [MEDIA_CACHE_ROOT];
  let visited = 0;
  while (stack.length && visited < 60000) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(fp); continue; }
      visited++;
      const ext = path.extname(e.name).toLowerCase();
      if (!IMG_EXT.has(ext) && !VID_EXT.has(ext)) continue;
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.size < 1024) continue; // skip tiny icons
      out.push({ rel: path.relative(MEDIA_CACHE_ROOT, fp), ext, kind: kindOf(ext), size: st.size, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  mediaIndex = out; mediaIndexAt = Date.now();
  log(`media cache indexed: ${out.length} files`);
  return out;
}
function getMediaIndex() { if (Date.now() - mediaIndexAt > 5 * 60 * 1000) buildMediaIndex(); return mediaIndex; }
function safeCachePath(rel) {
  const fp = path.resolve(MEDIA_CACHE_ROOT, rel);
  if (!fp.startsWith(path.resolve(MEDIA_CACHE_ROOT))) return null;
  return fp;
}
const CTYPE = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };

function extOf(url, ctype) {
  const m = (url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if (m) return "." + m.toLowerCase();
  if (ctype) { if (/jpeg|jpg/.test(ctype)) return ".jpg"; if (/png/.test(ctype)) return ".png"; if (/gif/.test(ctype)) return ".gif"; if (/mp4/.test(ctype)) return ".mp4"; if (/pdf/.test(ctype)) return ".pdf"; }
  return ".bin";
}
async function downloadMedia(rec) {
  const id = String(rec.msgId);
  if (downloadedMedia.has(id) || !rec.media) return;
  downloadedMedia.add(id);
  const url = rec.media.oriUrl || rec.media.normalUrl || rec.media.hdUrl || rec.media.href || rec.media.url || rec.media.thumbUrl;
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(to);
    if (!res.ok) { log(`media ${id}: HTTP ${res.status}`); return; }
    const buf = Buffer.from(await res.arrayBuffer());
    const file = id + extOf(url, res.headers.get("content-type") || "");
    fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
    const m = messages.get(id);
    if (m) { m.mediaLocal = "media/" + file; msgStream.write(JSON.stringify(m) + "\n"); }
    log(`media saved: ${file} (${(buf.length / 1024).toFixed(0)}KB)`);
  } catch (e) { log(`media ${id} fail: ${e.message}`); }
}

// ---------- in-memory state -------------------------------------------------
const messages = new Map();   // msgId -> last captured record
const recalls = [];           // list of { at, type, conversationId, msgIds, originals:[...] }
const seenActionTypes = new Set();
const recalledIds = new Set(); // msgIds known to be recalled
const nameByUid = new Map();   // uid -> display name (from message dName)

function noteName(uid, dName) {
  if (uid != null && dName && dName !== "undefined") nameByUid.set(String(uid), dName);
}
function nameOf(uid) {
  if (uid == null) return undefined;
  const u = String(uid);
  if (u === "0") return "Bạn";
  return nameByUid.get(u) || u;
}

const HERE = __dir;
function toast(title, message) {
  try {
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
      "-File", path.join(HERE, "toast.ps1"), "-Title", title, "-Message", message],
      { detached: true, stdio: "ignore" }).unref();
  } catch (e) {}
}

function loadExisting() {
  try {
    for (const line of fs.readFileSync(MESSAGES_LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.msgId) { messages.set(r.msgId, r); noteName(r.fromUid, r.dName); if (r.mediaLocal) downloadedMedia.add(String(r.msgId)); }
    }
  } catch {}
  try {
    for (const line of fs.readFileSync(RECALLS_LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      recalls.push(e);
      (e.msgIds || []).forEach((id) => recalledIds.add(String(id)));
    }
  } catch {}
  log(`loaded ${messages.size} messages, ${recalls.length} recalls from disk`);
}

const msgStream = fs.createWriteStream(MESSAGES_LOG, { flags: "a" });
const recallStream = fs.createWriteStream(RECALLS_LOG, { flags: "a" });

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ---------- record handlers -------------------------------------------------
const PLACEHOLDER_RE = /thu h[ồo]i|đã được thu hồi|tin nhắn đã/i;
function isEmptyContent(c) {
  if (c == null) return true;
  if (typeof c === "string") return c.trim() === "" || PLACEHOLDER_RE.test(c);
  if (typeof c === "object") {
    const s = c.title || c.text || c.caption || c.description || "";
    return s === "" || PLACEHOLDER_RE.test(String(s));
  }
  return false;
}
function onMessage(rec) {
  if (!rec || !rec.msgId) return;
  noteName(rec.fromUid, rec.dName);
  const prev = messages.get(rec.msgId);
  // Preserve the first captured ORIGINAL: if we already have real content and the new
  // record is empty or the recall placeholder, keep the original content/full.
  if (prev && !isEmptyContent(prev.content) && isEmptyContent(rec.content)) {
    const merged = Object.assign({}, prev, rec, { content: prev.content, full: prev.full, capturedAt: prev.capturedAt });
    messages.set(rec.msgId, merged);
    msgStream.write(JSON.stringify(merged) + "\n");
    return;
  }
  messages.set(rec.msgId, Object.assign({}, prev, rec, { capturedAt: rec._at }));
  msgStream.write(JSON.stringify(messages.get(rec.msgId)) + "\n");
  if (rec.media && !(prev && prev.mediaLocal)) downloadMedia(messages.get(rec.msgId));
}

function onRecall(rec) {
  // Global sidebar-based recall: carries the original preview text directly (no msgId).
  if (rec.type === "SIDEBAR_RECALL") {
    const entry = {
      at: rec._at || Date.now(), type: rec.type, conversationId: rec.conversationId, convName: rec.convName,
      msgIds: [], originals: [{ content: rec.originalText, dName: rec.convName, source: "sidebar" }],
    };
    recalls.push(entry);
    recallStream.write(JSON.stringify(entry) + "\n");
    log(`RECALL (sidebar) conv=${rec.convName || rec.conversationId} original="${String(rec.originalText).slice(0, 40)}"`);
    toast(`🔓 Thu hồi trong "${rec.convName || "hội thoại"}"`, String(rec.originalText || "").slice(0, 180));
    return;
  }
  const msgIds = (rec.msgIds || []).map(String);
  const originals = msgIds.map((id) => {
    const m = messages.get(id);
    return m ? { msgId: id, fromUid: m.fromUid, toUid: m.toUid, msgType: m.msgType, ts: m.ts, dName: m.dName, content: m.content, full: m.full }
             : { msgId: id, missing: true };
  });
  const entry = { at: rec._at || Date.now(), type: rec.type, conversationId: rec.conversationId, msgIds, originals, rawAction: rec.action };
  recalls.push(entry);
  msgIds.forEach((id) => recalledIds.add(id));
  recallStream.write(JSON.stringify(entry) + "\n");
  const found = originals.filter((o) => !o.missing).length;
  log(`RECALL (${rec.type}) ids=${msgIds.length} original-content-found=${found}`);
  // desktop notification with the recovered original (if any)
  const recovered = originals.find((o) => !o.missing);
  const who = recovered ? nameOf(recovered.fromUid) : "Ai đó";
  const text = recovered ? extractText(recovered) : null;
  toast(`🔓 ${who} vừa thu hồi 1 tin`, text ? String(text).slice(0, 180) : "(không có bản gốc đã lưu)");
}

function handleRecord(obj) {
  const { kind, data, at } = obj;
  if (kind === "msg") { data._at = at; onMessage(data); }
  else if (kind === "recall") { data._at = at; onRecall(data); }
  else if (kind === "action-type") { if (!seenActionTypes.has(data)) { seenActionTypes.add(data); } }
  else if (kind === "hook-status") { log("hook:", data, "@", obj.href || ""); }
  else if (kind === "error") { log("hook-error:", data); }
}

// ---------- minimal CDP client ---------------------------------------------
class CDP {
  constructor(wsUrl, targetId, label) {
    this.wsUrl = wsUrl; this.targetId = targetId; this.label = label;
    this.id = 0; this.pending = new Map(); this.ws = null; this.alive = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => { this.alive = true; resolve(); });
      ws.addEventListener("error", (e) => { if (!this.alive) reject(new Error("ws error")); });
      ws.addEventListener("close", () => { this.alive = false; });
      ws.addEventListener("message", (ev) => this._onMsg(ev.data));
    });
  }
  _onMsg(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? reject(new Error(m.error.message || JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === "Runtime.bindingCalled" && m.params && m.params.name === "__zcap") {
      try { handleRecord(JSON.parse(m.params.payload)); } catch (e) {}
    }
    if (m.method === "Page.loadEventFired") {
      // Zalo reloaded: the auto-injected hook re-ran with a fresh window, so re-seed
      // disk originals into the page for the overlay.
      setTimeout(() => this.seedOriginals().catch(() => {}), 1500);
    }
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 15000);
    });
  }
  async setup() {
    await this.send("Runtime.enable");
    await this.send("Page.enable").catch(() => {});
    await this.send("Runtime.addBinding", { name: "__zcap" });
    // re-inject on future document loads (reload / SPA re-mount)
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK_SRC }).catch(() => {});
    const r = await this.send("Runtime.evaluate", { expression: HOOK_SRC, awaitPromise: false, returnByValue: true });
    log(`[${this.label}] inject ->`, r && r.result ? r.result.value : "?");
    await this.seedOriginals();
  }
  async seedOriginals() {
    // Push disk-stored originals into the page so the in-Zalo overlay can show
    // the original text even for messages recalled before this run.
    const seed = buildSeed();
    const n = Object.keys(seed).length;
    if (!n) return;
    try {
      await this.send("Runtime.evaluate", {
        expression: `window.__zcapSeed && window.__zcapSeed(${JSON.stringify(seed)})`,
        returnByValue: true,
      });
      log(`[${this.label}] seeded ${n} originals`);
    } catch (e) { /* page may not be ready yet; live scan will still fill */ }
  }
}

// ---------- target discovery / attach loop ---------------------------------
const attached = new Map(); // targetId -> CDP
async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return await res.json();
}
// Guard against attaching to a foreign app that grabbed the port (a status-200 probe is
// not proof of identity). Warn once, keep running: a wrong app yields msg-store-not-found.
let appChecked = false;
async function checkAppIsZalo() {
  if (appChecked) return;
  appChecked = true;
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const j = await r.json();
    const ua = j["User-Agent"] || j.UserAgent || "";
    if (!/Zalo\//.test(ua)) log(`CANH BAO: port ${CDP_PORT} khong phai Zalo (UA: ${ua.slice(0, 80)}) — kiem tra lai port`);
    else log(`target app: ${ua.slice(0, 60)}`);
  } catch {}
}
async function attachLoop() {
  let announced = false;
  let lastErr = null;
  for (;;) {
    try {
      const targets = await listTargets();
      if (lastErr) { log("CDP poll recovered"); lastErr = null; }
      if (!announced) { await checkAppIsZalo(); log(`CDP up on ${CDP_PORT}; ${targets.length} targets`); announced = true; }
      for (const t of targets) {
        if (t.type !== "page") continue;
        if (!t.webSocketDebuggerUrl) continue;
        if (attached.has(t.id)) { if (!attached.get(t.id).alive) attached.delete(t.id); else continue; }
        const label = (t.title || t.url || t.id).slice(0, 40);
        const cdp = new CDP(t.webSocketDebuggerUrl, t.id, label);
        try { await cdp.connect(); await cdp.setup(); attached.set(t.id, cdp); log(`attached: ${label}`); }
        catch (e) { log(`attach failed ${label}:`, e.message); }
      }
    } catch (e) {
      // only log on transition, otherwise a dead port spams every 3s
      if (lastErr !== e.message) { log("CDP poll error:", e.message); lastErr = e.message; }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------- viewer server ---------------------------------------------------
function recalledView() {
  // newest first; join each recalled id with its captured original
  return recalls.slice().reverse().map((r) => ({
    at: r.at, type: r.type, conversationId: r.conversationId,
    convName: r.convName,
    items: r.originals.map((o) => ({
      msgId: o.msgId, from: o.fromUid, fromName: nameOf(o.fromUid) || o.dName || r.convName, to: o.toUid, msgType: o.msgType, ts: o.ts, dName: o.dName,
      recovered: !o.missing, source: o.source,
      text: extractText(o),
    })),
  }));
}

function textOfMsg(m) {
  if (typeof m.content === "string") return m.content;
  if (m.content && typeof m.content === "object") return m.content.title || m.content.text || m.content.caption || "";
  const f = m.full || {};
  return f.message || f.content || f.body || "";
}
function searchArchive(q, limit) {
  const needle = (q || "").toLowerCase();
  const out = [];
  for (const m of messages.values()) {
    let text = textOfMsg(m);
    if (typeof text !== "string") text = "";
    const hasMedia = !!(m.mediaLocal || m.media);
    if (!text && !hasMedia) continue;
    if (needle && !(text.toLowerCase().includes(needle) || (nameOf(m.fromUid) || "").toLowerCase().includes(needle))) continue;
    out.push({ msgId: m.msgId, fromName: nameOf(m.fromUid), fromUid: m.fromUid, conversationId: m.conversationId, ts: m.ts, text, recalled: recalledIds.has(String(m.msgId)), media: m.mediaLocal || (m.media && (m.media.href || m.media.oriUrl)) || null });
  }
  out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  return out.slice(0, limit || 300);
}
function buildSeed() {
  // {msgId: {content, dName, fromUid}} for messages that have real text content.
  const out = {};
  let n = 0;
  for (const [id, m] of messages) {
    if (n >= 8000) break;
    let text = null;
    if (typeof m.content === "string" && m.content.trim() && !PLACEHOLDER_RE.test(m.content)) text = m.content;
    else { const f = m.full || {}; const t = f.message || f.content || f.body; if (typeof t === "string" && t.trim() && !PLACEHOLDER_RE.test(t)) text = t; }
    if (!text) continue;
    out[id] = { content: text, dName: m.dName, fromUid: m.fromUid };
    n++;
  }
  return out;
}

function extractText(o) {
  if (!o || o.missing) return null;
  const c = o.content;
  if (typeof c === "string") return c;
  if (c && typeof c === "object") return c.title || c.text || c.caption || c.description || JSON.stringify(c).slice(0, 500);
  const f = o.full || {};
  return f.content || f.body || f.message || f.title || null;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url.startsWith("/index")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(VIEWER_HTML);
  } else if (req.url.startsWith("/api/recalled")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ stats: { messages: messages.size, recalls: recalls.length }, recalls: recalledView() }));
  } else if (req.url.startsWith("/api/search")) {
    const u = new URL(req.url, "http://x");
    const q = u.searchParams.get("q") || "";
    const limit = Math.min(1000, Number(u.searchParams.get("limit")) || 300);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ stats: { messages: messages.size, people: nameByUid.size }, results: searchArchive(q, limit) }));
  } else if (req.url.startsWith("/media/")) {
    const name = path.basename(decodeURIComponent(req.url.replace(/^\/media\//, "").split("?")[0]));
    const fp = path.join(MEDIA_DIR, name);
    if (fp.startsWith(MEDIA_DIR) && fs.existsSync(fp)) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `inline; filename="${name}"` });
      fs.createReadStream(fp).pipe(res);
    } else { res.writeHead(404); res.end("no media"); }
  } else if (req.url.startsWith("/api/media-cache")) {
    const u = new URL(req.url, "http://x");
    const kind = u.searchParams.get("kind") || "";
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const limit = Math.min(500, Number(u.searchParams.get("limit")) || 120);
    const offset = Number(u.searchParams.get("offset")) || 0;
    let idx = getMediaIndex();
    if (kind) idx = idx.filter((m) => m.kind === kind);
    if (q) idx = idx.filter((m) => m.rel.toLowerCase().includes(q));
    const page = idx.slice(offset, offset + limit).map((m) => ({
      f: m.rel.replace(/\\/g, "/"), ext: m.ext.slice(1), kind: m.kind, size: m.size, mtime: m.mtime,
    }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ total: idx.length, items: page }));
  } else if (req.url.startsWith("/cache")) {
    const u = new URL(req.url, "http://x");
    const rel = u.searchParams.get("f") || "";
    const thumb = u.searchParams.get("thumb") === "1";
    const fp = safeCachePath(rel);
    if (!fp || !fs.existsSync(fp)) { res.writeHead(404); res.end("no file"); return; }
    const ext = path.extname(fp).toLowerCase();
    try {
      if (ext === ".jxl") {
        const png = await jxlToPng(fp, PNG_CACHE, thumb ? 480 : 1600);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        fs.createReadStream(png).pipe(res);
      } else {
        res.writeHead(200, { "content-type": CTYPE[ext] || "application/octet-stream", "cache-control": "max-age=86400" });
        fs.createReadStream(fp).pipe(res);
      }
    } catch (e) { res.writeHead(500); res.end("convert error: " + e.message); }
  } else if (req.url.startsWith("/api/stats")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: messages.size, recalls: recalls.length, actionTypes: [...seenActionTypes].sort() }));
  } else {
    res.writeHead(404); res.end("not found");
  }
});

const VIEWER_HTML = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zalo — Thu hồi & Kho lưu trữ</title>
<style>
  :root{--bg:#0b1020;--card:#151b2e;--line:#243049;--fg:#e7ecf5;--mut:#8b96ab;--accent:#2dd4bf;--warn:#f59e0b;--me:#60a5fa}
  @media(prefers-color-scheme:light){:root{--bg:#f4f6fb;--card:#fff;--line:#e3e8f2;--fg:#131722;--mut:#5b6678;--accent:#0d9488;--me:#2563eb}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
  header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 18px}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  h1{font-size:16px;margin:0}
  .stat{color:var(--mut);font-size:13px}.stat b{color:var(--accent)}
  .tabs{display:flex;gap:6px;margin-top:10px}
  .tab{padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;font-weight:600}
  .tab.active{background:var(--accent);color:#031;border-color:var(--accent)}
  main{max-width:880px;margin:0 auto;padding:14px 16px 70px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 15px;margin:10px 0}
  .meta{display:flex;gap:9px;flex-wrap:wrap;color:var(--mut);font-size:12px;margin-bottom:6px;align-items:center}
  .who{font-weight:700;color:var(--fg)}.who.me{color:var(--me)}
  .tag{background:var(--line);border-radius:999px;padding:2px 9px}
  .tag.warn{color:#000;background:var(--warn)}
  .txt{white-space:pre-wrap;word-break:break-word}
  .missing{color:var(--mut);font-style:italic}
  .empty{color:var(--mut);text-align:center;padding:50px 0}
  footer{color:var(--mut);font-size:12px;text-align:center;padding:18px}
  input[type=search]{flex:1;min-width:180px;background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:9px;padding:8px 12px;font-size:14px}
  button{background:var(--accent);color:#031;border:0;border-radius:8px;padding:7px 12px;font-weight:600;cursor:pointer}
  .pill{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--warn);color:#000}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
  .cell{position:relative;aspect-ratio:1;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--card);display:flex;align-items:center;justify-content:center}
  .cell img{width:100%;height:100%;object-fit:cover;cursor:pointer;display:block}
  .cell .badge{position:absolute;bottom:4px;left:4px;font-size:10px;background:rgba(0,0,0,.6);color:#fff;padding:1px 6px;border-radius:6px}
  .cell a{color:var(--accent);text-decoration:none;font-size:12px;padding:6px;text-align:center;word-break:break-all}
  .kinds{display:flex;gap:6px;margin-left:8px}
  .kinds button{background:transparent;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:4px 10px}
  .kinds button.on{background:var(--accent);color:#031;border-color:var(--accent)}
</style></head><body>
<header>
  <div class="row">
    <h1>🗂️ Zalo Recall & Archive</h1>
    <span class="stat">Tin đã chụp: <b id="m">0</b> · Thu hồi: <b id="r">0</b> · Người: <b id="p">0</b></span>
    <span style="flex:1"></span>
    <label class="stat"><input type="checkbox" id="auto" checked> Tự làm mới</label>
  </div>
  <div class="tabs">
    <button class="tab active" data-t="recall" onclick="setTab('recall')">Tin thu hồi</button>
    <button class="tab" data-t="archive" onclick="setTab('archive')">Kho lưu trữ (tìm kiếm)</button>
    <button class="tab" data-t="media" onclick="setTab('media')">Thư viện media</button>
  </div>
  <div class="row" id="searchbar" style="margin-top:10px;display:none">
    <input type="search" id="q" placeholder="Tìm theo nội dung hoặc tên người gửi…" oninput="debSearch()">
    <button onclick="doSearch()">Tìm</button>
    <div class="kinds" id="kinds" style="display:none">
      <button class="on" data-k="" onclick="setKind('')">Tất cả</button>
      <button data-k="image" onclick="setKind('image')">Ảnh</button>
      <button data-k="video" onclick="setKind('video')">Video</button>
      <button data-k="file" onclick="setKind('file')">File</button>
    </div>
  </div>
</header>
<main id="list"><div class="empty">Đang tải…</div></main>
<footer>Dữ liệu chỉ lưu cục bộ trên máy bạn · tài khoản của chính bạn</footer>
<script>
let tab='recall';
function fmt(ts){ if(!ts) return ''; const n=Number(ts); const d=new Date(n>1e12?n:n*1000); return isNaN(d)?'':d.toLocaleString('vi-VN'); }
function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
let mediaKind='';
function setTab(t){ tab=t; document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.t===t));
  const sb=document.getElementById('searchbar'); sb.style.display=(t==='archive'||t==='media')?'flex':'none';
  document.getElementById('kinds').style.display = t==='media'?'flex':'none';
  document.getElementById('q').placeholder = t==='media'?'Lọc theo tên file/đường dẫn…':'Tìm theo nội dung hoặc tên người gửi…';
  load(); }
function setKind(k){ mediaKind=k; document.querySelectorAll('.kinds button').forEach(b=>b.classList.toggle('on',b.dataset.k===k)); loadMedia(); }
async function loadMedia(){
  const q=encodeURIComponent(document.getElementById('q').value||'');
  const j=await (await fetch('/api/media-cache?limit=200&kind='+mediaKind+'&q='+q)).json();
  const list=document.getElementById('list');
  if(!j.items.length){ list.innerHTML='<div class="empty">Không có media.</div>'; return; }
  list.innerHTML='<div class="grid">'+j.items.map(it=>{
    const src='/cache?f='+encodeURIComponent(it.f);
    if(it.kind==='image') return '<div class="cell"><img loading="lazy" src="'+src+'&thumb=1" onclick="window.open(\\''+src+'\\')"><span class="badge">'+it.ext+'</span></div>';
    if(it.kind==='video') return '<div class="cell"><a href="'+src+'" target="_blank">▶ video<br>'+Math.round(it.size/1024/1024*10)/10+'MB</a><span class="badge">'+it.ext+'</span></div>';
    return '<div class="cell"><a href="'+src+'" target="_blank">📄 '+it.ext+'<br>'+Math.round(it.size/1024)+'KB</a></div>';
  }).join('')+'</div>';
}
async function statHead(){ try{ const s=await (await fetch('/api/search?limit=1')).json(); }catch(e){} }
async function loadRecall(){
  const j = await (await fetch('/api/recalled')).json();
  document.getElementById('m').textContent=j.stats.messages; document.getElementById('r').textContent=j.stats.recalls;
  const list=document.getElementById('list');
  if(!j.recalls.length){ list.innerHTML='<div class="empty">Chưa bắt được tin thu hồi nào.</div>'; return; }
  list.innerHTML=j.recalls.map(ev=>ev.items.map(it=>\`
    <div class="card">
      <div class="meta"><span class="pill">THU HỒI</span>
        <span class="who">\${esc(it.fromName||it.from||'?')}</span>
        <span class="tag">gửi \${esc(fmt(it.ts))}</span><span class="tag">thu hồi \${esc(fmt(ev.at))}</span>
      </div>
      \${ it.recovered ? '<div class="txt">'+esc(it.text||'[không phải text]')+'</div>'
          : '<div class="missing">Không khôi phục được (thu hồi trước khi bật công cụ).</div>' }
    </div>\`).join('')).join('');
}
async function loadArchive(){
  const q=encodeURIComponent(document.getElementById('q').value||'');
  const j = await (await fetch('/api/search?q='+q+'&limit=400')).json();
  document.getElementById('m').textContent=j.stats.messages; document.getElementById('p').textContent=j.stats.people;
  const list=document.getElementById('list');
  if(!j.results.length){ list.innerHTML='<div class="empty">Không có tin nào khớp.</div>'; return; }
  list.innerHTML=j.results.map(it=>\`
    <div class="card">
      <div class="meta">
        <span class="who \${it.fromUid==='0'?'me':''}">\${esc(it.fromName||it.fromUid||'?')}</span>
        <span class="tag">\${esc(fmt(it.ts))}</span>
        \${it.recalled?'<span class="pill">đã thu hồi</span>':''}
      </div>
      <div class="txt">\${esc(it.text)}</div>
      \${ it.media ? ('<div style="margin-top:6px"><a href="'+ (it.media.startsWith('http')?it.media:('/'+it.media)) +'" target="_blank" style="color:var(--accent)">📎 Mở media đã lưu</a></div>') : '' }
    </div>\`).join('');
}
async function load(){ try{ if(tab==='recall') await loadRecall(); else if(tab==='archive') await loadArchive(); else await loadMedia(); }catch(e){} }
let dt=null; function debSearch(){ clearTimeout(dt); dt=setTimeout(doSearch,300); }
function doSearch(){ if(tab==='archive') loadArchive(); else if(tab==='media') loadMedia(); }
load(); setInterval(()=>{ if(document.getElementById('auto').checked && tab!=='media') load(); }, 4000);
</script></body></html>`;

// ---------- boot ------------------------------------------------------------
loadExisting();
try { buildMediaIndex(); } catch (e) { log("media index error: " + e.message); }
server.listen(VIEWER_PORT, "127.0.0.1", () => log(`viewer: http://localhost:${VIEWER_PORT}`));
log(`connecting to Zalo CDP on 127.0.0.1:${CDP_PORT} … (start Zalo via start.ps1 if not yet)`);
attachLoop();
