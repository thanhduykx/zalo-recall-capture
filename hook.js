/*
 * hook.js (v2) — injected into Zalo's renderer main world via CDP.
 *
 * Zalo keeps messages in a Redux store at:  state.conversations.alls[convId].messages[]
 * (field `message` = text, `msgType` 1 = text, `fromUid` "0" = you). Incoming messages,
 * edits and recalls all mutate that store, which then emits generic ITEM/LIST_CHANGED.
 *
 * Strategy: find that store, subscribe, and on each (debounced) change scan the loaded
 * messages. Keep a per-msgId snapshot. A message whose content goes from non-empty to
 * empty / "[Tin nhắn đã thu hồi]" (object stays in place) == a RECALL ("thu hồi") or
 * delete-for-everyone. We already captured the original, so it is preserved.
 *
 * Sends records to the Node agent via the CDP binding window.__zcap(json).
 * Scope: the signed-in user's own account on this machine. It only READS store state
 * (plus store.subscribe); it never dispatches or alters Zalo behaviour.
 */
(function () {
  const BINDING = "__zcap";
  if (typeof window[BINDING] !== "function") return "no-binding";

  const send = (kind, data) => {
    try { window[BINDING](JSON.stringify({ kind, data, at: Date.now(), href: location.href })); }
    catch (e) { try { window[BINDING](JSON.stringify({ kind: "error", data: String(e && e.message || e), at: Date.now() })); } catch (_) {} }
  };

  const MAX_STR = 4000;
  function trim(o, d) {
    d = d || 0;
    if (o == null) return o;
    const t = typeof o;
    if (t === "string") return o.length > MAX_STR ? o.slice(0, MAX_STR) + "…[+" + (o.length - MAX_STR) + "]" : o;
    if (t === "number" || t === "boolean") return o;
    if (t !== "object") return undefined;
    if (d > 4) return "[deep]";
    if (Array.isArray(o)) return o.slice(0, 50).map((x) => trim(x, d + 1));
    const out = {};
    let n = 0;
    for (const k in o) {
      if (n++ > 60) break;
      if (/thumb|rawUrl|normalUrl|hdUrl|avatar|photoUrl|base64|buffer/i.test(k)) { out[k] = "[skipped]"; continue; }
      try { out[k] = trim(o[k], d + 1); } catch (e) { out[k] = "[err]"; }
    }
    return out;
  }

  const PLACEHOLDER = /thu h[ồo]i|đã được thu hồi|tin nhắn đã thu/i;
  function contentOf(m) {
    const c = m.message !== undefined ? m.message : (m.content !== undefined ? m.content : m.body);
    return c;
  }
  function asStr(c) { return typeof c === "string" ? c : (c == null ? "" : (() => { try { return JSON.stringify(c); } catch { return ""; } })()); }
  function isEmpty(c) {
    if (c == null) return true;
    if (typeof c === "string") return c.trim() === "" || PLACEHOLDER.test(c);
    if (typeof c === "object") {
      // media (image/file/link) carries a URL even when title is empty -> not empty
      for (const k of ["oriUrl", "normalUrl", "hdUrl", "thumbUrl", "href", "url"]) if (typeof c[k] === "string" && /^https?:/i.test(c[k])) return false;
      const s = c.title || c.text || c.caption || c.description || "";
      return (!s) || PLACEHOLDER.test(String(s));
    }
    return false;
  }

  // Extract media/file URLs so recalled media can be re-downloaded & kept.
  function mediaUrls(m) {
    const msg = m && m.message;
    if (!msg || typeof msg !== "object") return undefined;
    const u = {};
    for (const k of ["oriUrl", "normalUrl", "hdUrl", "thumbUrl", "href", "url"]) {
      if (typeof msg[k] === "string" && /^https?:/i.test(msg[k])) u[k] = msg[k];
    }
    return Object.keys(u).length ? u : undefined;
  }
  function pack(m, convId) {
    const c = contentOf(m);
    const media = mediaUrls(m);
    return {
      msgId: String(m.msgId),
      cliMsgId: m.cliMsgId != null ? String(m.cliMsgId) : undefined,
      fromUid: m.fromUid != null ? String(m.fromUid) : undefined,
      toUid: m.toUid != null ? String(m.toUid) : undefined,
      conversationId: String(convId),
      msgType: m.msgType,
      ts: m.serverTime || m.sendDttm || m.localDttm,
      dName: m.dName,
      content: trim(c),
      media,
      full: trim(m),
    };
  }

  // ---- find all Redux stores, then the one holding messages -------------------
  function fiberKey(el) {
    for (const k in el) if (k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return k;
    return null;
  }
  function findAllStores() {
    const stores = new Set();
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const k = fiberKey(all[i]);
      if (!k) continue;
      let f = all[i][k]; if (f && f.current) f = f.current;
      let d = 0;
      while (f && d < 60) {
        const cand = [f.memoizedProps && f.memoizedProps.store, f.stateNode && f.stateNode.store];
        for (const s of cand) if (s && typeof s.dispatch === "function" && typeof s.getState === "function" && typeof s.subscribe === "function") stores.add(s);
        f = f.return; d++;
      }
    }
    return [...stores];
  }
  function findMsgStore() {
    for (const s of findAllStores()) {
      try { const st = s.getState(); if (st && st.conversations && st.conversations.alls) return s; } catch (e) {}
    }
    return null;
  }

  // ---- snapshot + diff --------------------------------------------------------
  const prev = new Map();          // msgId -> { c:contentStr, empty:bool, t:msgType }
  const convSig = new Map();       // convId -> signature, to skip unchanged conversations
  let firstPass = true;

  // Originals preserved for the in-Zalo overlay (msgId -> {content, dName}); seeded
  // from disk by the agent and filled live. Never overwritten with empty content.
  const originals = (window.__zcapOriginals = window.__zcapOriginals || new Map());
  function rememberOriginal(m) {
    const id = String(m.msgId);
    const c = contentOf(m);
    if (isEmpty(c)) return;
    if (!originals.has(id)) originals.set(id, { content: typeof c === "string" ? c : asStr(c), dName: m.dName, msgType: m.msgType, fromUid: m.fromUid != null ? String(m.fromUid) : undefined });
  }
  // Agent calls this to merge disk-stored originals into the page.
  window.__zcapSeed = function (obj) {
    try { let n = 0; for (const id in obj) { if (!originals.has(id) && obj[id] && obj[id].content) { originals.set(id, obj[id]); n++; } } if (n) scheduleEnhance(); return originals.size; } catch (e) { return -1; }
  };

  const MSG_UNDO = 20; // learned from the bundle/runtime (props.data.msgType === 20 on recalled)

  function scan(store) {
    let st; try { st = store.getState(); } catch (e) { return; }
    const alls = st && st.conversations && st.conversations.alls;
    if (!alls) return;
    for (const convId in alls) {
      const conv = alls[convId];
      if (!conv || !Array.isArray(conv.messages)) continue;
      const msgs = conv.messages;
      const sig = msgs.length + ":" + (msgs.length ? msgs[msgs.length - 1].msgId + ":" + (msgs[msgs.length - 1].msgType) : "0");
      // Note: a recall changes msgType of an existing msg, which changes neither length nor
      // last id — so we cannot skip purely on sig. We cheaply hash content of last 60 msgs.
      let contentSig = "";
      const from = Math.max(0, msgs.length - 120);
      for (let i = from; i < msgs.length; i++) { const m = msgs[i]; if (m) contentSig += m.msgId + "=" + (isEmpty(contentOf(m)) ? 0 : 1) + ";"; }
      const fullSig = sig + "|" + contentSig;
      if (convSig.get(convId) === fullSig) continue;
      convSig.set(convId, fullSig);

      for (let i = from; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m || m.msgId == null) continue;
        const id = String(m.msgId);
        const c = contentOf(m);
        const empty = isEmpty(c) || m.msgType === MSG_UNDO;
        const cStr = asStr(c);
        if (!empty) rememberOriginal(m);
        const p = prev.get(id);
        if (!p) {
          prev.set(id, { c: cStr, empty, t: m.msgType });
          if (!empty) send("msg", pack(m, convId));
          // if it appears already-empty we can't recover it (recalled before capture)
        } else if (!p.empty && empty) {
          // content disappeared in place => recall / delete-for-everyone
          send("recall", { type: "DIFF_RECALL", msgIds: [id], conversationId: String(convId), newMsgType: m.msgType, prevMsgType: p.t });
          prev.set(id, { c: cStr, empty, t: m.msgType });
          scheduleEnhance();
        } else if (p.c !== cStr) {
          prev.set(id, { c: cStr, empty, t: m.msgType });
          if (!empty) send("msg", pack(m, convId)); // edit / content update
        }
      }
    }
    firstPass = false;
  }

  // ---- in-Zalo overlay: show recovered original under the "đã thu hồi" note ----
  function msgIdOfUndoSpan(span) {
    let f = fiberKey(span) ? span[fiberKey(span)] : null;
    let d = 0;
    while (f && d < 40) {
      const ps = f.memoizedProps;
      if (ps) {
        if (ps.data && ps.data.msgId != null) return String(ps.data.msgId);
        if (ps.message && ps.message.msgId != null) return String(ps.message.msgId);
        if (ps.msgId != null) return String(ps.msgId);
        for (const k in ps) { const v = ps[k]; if (v && typeof v === "object" && v.msgId != null && (v.msgType != null || v.message !== undefined)) return String(v.msgId); }
      }
      f = f.return; d++;
    }
    return null;
  }
  function injectStyle() {
    if (document.getElementById("zcap-style")) return;
    const st = document.createElement("style");
    st.id = "zcap-style";
    st.textContent =
      ".zcap-restored{display:inline-block;margin-top:4px;padding:3px 8px;border-radius:8px;" +
      "background:rgba(45,212,191,.16);border:1px solid rgba(45,212,191,.5);color:#0b7a6e;" +
      "font-style:normal;font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-width:420px}" +
      ".zcap-restored b{font-style:normal;opacity:.7;margin-right:4px}" +
      ".zcap-none{color:#b45309;background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.4)}";
    (document.head || document.documentElement).appendChild(st);
  }
  function enhance() {
    injectStyle();
    const spans = document.querySelectorAll("span.undo-message:not([data-zcap])");
    spans.forEach((s) => {
      s.setAttribute("data-zcap", "1");
      const id = msgIdOfUndoSpan(s);
      if (!id) { s.removeAttribute("data-zcap"); return; } // fiber not ready; retry later
      const o = originals.get(id);
      const box = document.createElement("span");
      if (o && o.content) { box.className = "zcap-restored"; box.innerHTML = ""; box.appendChild(document.createTextNode("🔓 " + o.content)); }
      else { box.className = "zcap-restored zcap-none"; box.textContent = "🔓 (không có bản gốc — thu hồi trước khi bật công cụ)"; }
      // place the restored text on its own line after the placeholder
      const host = s.parentElement || s;
      host.appendChild(document.createElement("br"));
      host.appendChild(box);
    });
  }
  // ---- GLOBAL sidebar recall detection (covers unopened conversations) --------
  // Each .conv-item shows the last-message preview in span.inline and the name in
  // .truncate. We snapshot each conversation's preview; when it flips to the recall
  // placeholder while we held real prior text, we report a recall with that text.
  function convIdOfRow(el) {
    let f = fiberKey(el) ? el[fiberKey(el)] : null, d = 0;
    while (f && d < 50) {
      const ps = f.memoizedProps;
      if (ps) {
        const c = ps.conversation;
        if (c && (c.userId != null || c.conversationId != null)) return String(c.userId != null ? c.userId : c.conversationId);
        for (const k of ["conversationId", "convId", "userId", "threadId", "id"]) {
          if (ps[k] != null && /^[-A-Za-z0-9]+$/.test(String(ps[k])) && String(ps[k]).length > 5) return String(ps[k]);
        }
        if (ps.data && ps.data.conversationId != null) return String(ps.data.conversationId);
      }
      f = f.return; d++;
    }
    return null;
  }
  const sidebarPrev = new Map();     // convId -> last real preview text
  const sidebarReported = new Set(); // convId + "\\u0000" + originalText (dedup)
  function scanSidebar() {
    const rows = document.querySelectorAll(".conv-item");
    rows.forEach((row) => {
      const cid = convIdOfRow(row);
      if (!cid) return;
      const prevEl = row.querySelector("span.inline");
      const nameEl = row.querySelector(".truncate");
      const preview = prevEl ? (prevEl.textContent || "").trim() : "";
      const name = nameEl ? (nameEl.textContent || "").trim() : undefined;
      if (!preview) return;
      const isPlaceholder = PLACEHOLDER.test(preview);
      if (isPlaceholder) {
        const prior = sidebarPrev.get(cid);
        if (prior && !PLACEHOLDER.test(prior)) {
          const key = cid + "\\u0000" + prior;
          if (!sidebarReported.has(key)) {
            sidebarReported.add(key);
            send("recall", { type: "SIDEBAR_RECALL", conversationId: cid, convName: name, originalText: prior });
          }
        }
      } else {
        sidebarPrev.set(cid, preview);
      }
    });
  }

  let enhTimer = null;
  function scheduleEnhance() { if (!enhTimer) enhTimer = setTimeout(() => { enhTimer = null; try { enhance(); scanSidebar(); } catch (e) {} }, 120); }
  function startOverlay() {
    scheduleEnhance();
    const mo = new MutationObserver(() => scheduleEnhance());
    mo.observe(document.body, { childList: true, subtree: true });
    // periodic safety sweep (covers virtualized list re-renders)
    setInterval(scheduleEnhance, 2500);
  }

  let tries = 0;
  function install() {
    const store = findMsgStore();
    if (!store) {
      if (tries++ < 90) { setTimeout(install, 1000); return; }
      send("hook-status", "msg-store-not-found");
      return;
    }
    const HOOK_VERSION = 5; // bump when hook.js changes so a re-inject re-scans/re-subscribes
    if (store.__zcapMsgHooked && store.__zcapVersion === HOOK_VERSION) return "already";
    store.__zcapMsgHooked = true;
    store.__zcapVersion = HOOK_VERSION;
    window.__zcapMsgStore = store;
    send("hook-status", "msg-store-found");

    let timer = null;
    const run = () => { timer = null; try { scan(store); } catch (e) { send("error", "scan:" + (e && e.message)); } };
    store.subscribe(() => { if (!timer) timer = setTimeout(run, 250); });
    scan(store);        // initial snapshot of already-loaded messages
    startOverlay();     // start showing recovered originals inside Zalo
    send("hook-status", "installed-v3-overlay");
    return "installed";
  }

  return install();
})();
