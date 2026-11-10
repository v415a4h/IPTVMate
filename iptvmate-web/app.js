/* IPTV / M3U Web Player — improved build
   - Uses the same element IDs as the original, so it drops into your existing HTML.
   - Extra UI (control bar, loading spinner) is injected automatically.
   - Optional: ?playlist=<url>  and  ?proxy=<cors-proxy>  (use ?proxy=off to clear)  */
(() => {
  "use strict";

  /* ================= helpers, config, storage ================= */
  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt);

  const store = {
    get(k, d) { try { const v = localStorage.getItem("iptv:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("iptv:" + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem("iptv:" + k); } catch {} }
  };

  const qs = new URLSearchParams(location.search);
  if (qs.has("proxy")) store.set("proxy", qs.get("proxy") === "off" ? "" : qs.get("proxy"));

  const CONFIG = {
    // CORS proxy template, e.g. "https://my-proxy.example/?url={url}" (or a plain prefix). Empty = disabled.
    proxy: store.get("proxy", ""),
    startTimeout: 12000, fetchTimeout: 30000, stallTimeout: 20000,
    maxRetries: 4, pageSize: 200, historyMax: 8, prebufferMax: 12000,
    libs: {
      hls: "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js",
      mpegts: "https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js",
      dash: "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js"
    }
  };
  const LABELS = { hls: "HLS", mpegts: "MPEG-TS", dash: "DASH", native: "Native" };

  // Buffer profiles: more delay = fewer stalls.
  //  prebuffer = seconds to buffer before showing the stream; cushion = seconds to rebuild after a stall.
  const PROFILES = {
    smooth: { label: "Smooth", prebuffer: 8, cushion: 6,
      hls: { lowLatencyMode: false, maxBufferLength: 60, maxMaxBufferLength: 180, maxBufferSize: 120e6, backBufferLength: 30,
        liveSyncDuration: 20, liveMaxLatencyDuration: 90, maxBufferHole: 0.5, nudgeMaxRetry: 10, startFragPrefetch: true,
        capLevelToPlayerSize: true, abrBandWidthFactor: 0.8, abrBandWidthUpFactor: 0.5 },
      mpegts: { liveBufferLatencyChasing: false, enableStashBuffer: true, stashInitialSize: 1024 * 1024,
        autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 15 } },
    balanced: { label: "Balanced", prebuffer: 3, cushion: 3,
      hls: { lowLatencyMode: false, maxBufferLength: 40, maxMaxBufferLength: 90, backBufferLength: 30,
        liveSyncDuration: 10, liveMaxLatencyDuration: 40, maxBufferHole: 0.3, nudgeMaxRetry: 6,
        capLevelToPlayerSize: true, abrBandWidthFactor: 0.85, abrBandWidthUpFactor: 0.6 },
      mpegts: { liveBufferLatencyChasing: false, enableStashBuffer: true, autoCleanupSourceBuffer: true } },
    low: { label: "Low delay", prebuffer: 0, cushion: 0,
      hls: { maxBufferLength: 20, backBufferLength: 15 },
      mpegts: { liveBufferLatencyChasing: true, enableStashBuffer: false } }
  };
  let mode = store.get("mode", "smooth"); if (!PROFILES[mode]) mode = "smooth";
  const profile = () => PROFILES[mode];

  const state = {
    channels: [], byId: new Map(), counts: new Map(), filtered: [], rendered: 0, limit: CONFIG.pageSize,
    category: "All", view: "live", current: null, engine: null, playing: false, retries: 0,
    favorites: new Set(store.get("fav", [])), recent: store.get("recent", []),
    playlistName: "", source: null, hints: new Map(),
    toastTimer: 0, retryTimer: 0, stallTimer: 0, searchTimer: 0, holding: false, label: "", stalls: []
  };
  let playToken = 0;
  const baseTitle = document.title;

  const els = {
    video: $("video"), placeholder: $("videoPlaceholder"), videoError: $("videoError"),
    channelList: $("channelList"), categoryList: $("categoryList"), channelCount: $("channelCount"),
    playlistStatus: $("playlistStatus"), search: $("searchInput"), title: $("pageTitle"),
    subtitle: $("pageSubtitle"), listTitle: $("listTitle"), nowTitle: $("nowTitle"),
    nowMeta: $("nowMeta"), nowAvatar: $("nowAvatar"), nowFav: $("nowFavBtn"),
    dialog: $("playlistDialog"), url: $("playlistUrl"), file: $("playlistFile"),
    dialogError: $("dialogError"), importBtn: $("importBtn"), toast: $("toast")
  };

  /* ================= small utilities ================= */
  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message; els.toast.classList.add("show");
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
  }
  const initials = (name) => (name || "TV").trim().split(/\s+/).slice(0, 2).map((s) => s[0] || "").join("").toUpperCase();
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function normalizeUrl(value, base) { try { return new URL(value, base || location.href).href; } catch { return value; } }
  const proxify = (u) => !CONFIG.proxy ? u : CONFIG.proxy.includes("{url}") ? CONFIG.proxy.replace("{url}", encodeURIComponent(u)) : CONFIG.proxy + u;

  // Ordered list of URLs to try: https upgrade for http streams, then optional proxy.
  function urlCandidates(url) {
    const out = [], http = /^http:/i.test(url), secure = location.protocol === "https:";
    if (http && secure) out.push({ url: url.replace(/^http:/i, "https:") });   // http would be blocked as mixed content
    else { out.push({ url }); if (http) out.push({ url: url.replace(/^http:/i, "https:") }); }
    if (CONFIG.proxy) out.push({ url, proxy: true });
    return out;
  }

  const libCache = {};
  function loadLib(global, src) {
    if (window[global]) return Promise.resolve();
    return (libCache[global] ||= new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.async = true; s.onload = res;
      s.onerror = () => { delete libCache[global]; rej(new Error(`Could not load ${global} library`)); };
      document.head.appendChild(s);
    }));
  }

  /* ================= M3U parsing ================= */
  function parseAttributes(line) {
    const attrs = {}, re = /([\w.-]+)=(?:"([^"]*)"|'([^']*)')/g; let m;
    while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim();
    return attrs;
  }
  // Split "#EXTINF:-1 attrs...,Name" at the first comma that is NOT inside quotes.
  function splitExtinf(line) {
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === "," && !inQ) return [line.slice(0, i), line.slice(i + 1).trim()];
    }
    return [line, ""];
  }
  function makeChannel(c) {
    const group = (c.group || "Other").trim() || "Other";
    return { id: hash(`${c.url}|${c.name}`), name: c.name, group, logo: c.logo || "", tvgId: c.tvgId || "", url: c.url,
      search: `${c.name} ${group} ${c.tvgId || ""}`.toLowerCase() };
  }
  function parseM3U(text, baseUrl, name) {
    text = text.replace(/^\uFEFF/, "");
    // The "playlist" is actually a single HLS stream, not a channel list.
    if (baseUrl && /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(text))
      return { channels: [makeChannel({ name: name || "Stream", url: baseUrl })], skipped: 0 };

    const channels = [], seen = new Set(); let skipped = 0, cur = null, extGrp = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith("#EXTINF")) {
        const [meta, title] = splitExtinf(line), a = parseAttributes(meta);
        cur = { name: title || a["tvg-name"] || "Unknown channel", group: a["group-title"] || extGrp,
          logo: a["tvg-logo"] || "", tvgId: a["tvg-id"] || "" };
      } else if (/^#EXTGRP:/i.test(line)) { extGrp = line.slice(8).trim();
      } else if (line.startsWith("#")) { continue;
      } else {
        const url = normalizeUrl(line, baseUrl);
        if (!/^https?:\/\//i.test(url)) { skipped++; cur = null; extGrp = ""; continue; }   // rtmp/udp/rtsp can't play in browsers
        const info = cur || { name: decodeURIComponent(url.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "Stream"), group: extGrp };
        const key = `${url}|${info.name}`;
        if (!seen.has(key)) { seen.add(key); channels.push(makeChannel({ ...info, url })); }
        cur = null; extGrp = "";
      }
    }
    return { channels, skipped };
  }

  /* ================= playlist loading ================= */
  async function fetchWithTimeout(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(t); }
  }
  async function fetchPlaylist(url) {
    let lastErr;
    for (const c of urlCandidates(url)) {
      try {
        const res = await fetchWithTimeout(c.proxy ? proxify(c.url) : c.url, CONFIG.fetchTimeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { text: await res.text(), base: c.proxy ? c.url : (res.url || c.url) };
      } catch (e) { lastErr = e.name === "AbortError" ? new Error("request timed out") : e; }
    }
    throw new Error(`Could not fetch the playlist (${lastErr?.message || "network error"}). ` +
      (CONFIG.proxy ? "" : "The server probably blocks browser (CORS) requests: download the file and import it, or set a CORS proxy with ?proxy=."));
  }
  function showDialogError(message) { els.dialogError.textContent = message; els.dialogError.classList.remove("hidden"); }
  function openDialog() { els.dialogError.classList.add("hidden"); els.dialog.showModal(); }

  function loadText(text, base, name, source) {
    const { channels, skipped } = parseM3U(text, base, name);
    if (!channels.length) throw new Error(skipped
      ? `Found ${skipped} streams, but none use HTTP/HTTPS (RTMP, UDP and RTSP can't play in a browser).`
      : "No playable channels found. Check that this is an M3U playlist.");
    stopPlayback(); state.current = null;
    setChannels(channels, name); state.source = source;
    persistPlaylist(name, source);
    toast(`Loaded ${channels.length.toLocaleString()} channels${skipped ? ` · ${skipped} unsupported skipped` : ""}`);
  }
  async function readPlaylist() {
    els.dialogError.classList.add("hidden");
    const file = els.file.files && els.file.files[0], url = els.url.value.trim();
    if (!file && !url) return showDialogError("Enter a playlist URL or choose a local M3U file.");
    els.importBtn.disabled = true; els.importBtn.textContent = "Loading…";
    try {
      if (file) loadText(await file.text(), "", file.name, { type: "file", name: file.name });
      else {
        const u = new URL(url);
        if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only HTTP and HTTPS playlist URLs are supported.");
        const { text, base } = await fetchPlaylist(url);
        loadText(text, base, u.hostname, { type: "url", url });
      }
      if (els.dialog.open) els.dialog.close();
    } catch (error) {
      if (!els.dialog.open) els.dialog.showModal();
      showDialogError(error.message || "Could not load playlist.");
    } finally { els.importBtn.disabled = false; els.importBtn.textContent = "Load playlist"; }
  }
  function persistPlaylist(name, source) {
    store.del("channels");
    store.set("channels", { name, channels: state.channels.map(({ name, group, logo, tvgId, url }) => ({ name, group, logo, tvgId, url })) });
    store.set("source", source);
    if (source?.type === "url") {
      store.set("hist", [source.url, ...store.get("hist", []).filter((u) => u !== source.url)].slice(0, CONFIG.historyMax));
      renderHistory();
    }
  }
  function renderHistory() {
    let dl = $("playlistHistory");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "playlistHistory"; document.body.appendChild(dl); els.url?.setAttribute("list", "playlistHistory"); }
    dl.textContent = "";
    store.get("hist", []).forEach((u) => { const o = document.createElement("option"); o.value = u; dl.appendChild(o); });
  }

  /* ================= list / categories ================= */
  function setChannels(channels, name) {
    state.channels = channels; state.byId = new Map(channels.map((c) => [c.id, c]));
    state.counts = new Map(); channels.forEach((c) => state.counts.set(c.group, (state.counts.get(c.group) || 0) + 1));
    state.playlistName = name; state.category = "All"; state.view = "live"; els.search.value = "";
    renderCategories(); updatePage(); renderChannels();
    els.playlistStatus.textContent = `${channels.length.toLocaleString()} channels · ${name}`;
  }
  function renderCategories() {
    els.categoryList.textContent = "";
    const make = (label, value, count) => {
      const b = document.createElement("button"); b.className = "category" + (state.category === value ? " active" : "");
      b.dataset.category = value; b.textContent = label; b.title = `${label} (${count})`; els.categoryList.appendChild(b);
    };
    make(`All channels (${state.channels.length})`, "All", state.channels.length);
    [...state.counts.keys()].sort((a, b) => a.localeCompare(b)).forEach((g) => make(g, g, state.counts.get(g)));
  }
  function updatePage() {
    const labels = { live: ["Live TV", "Your channels, all in one place.", "Channels"], favorites: ["Favourites", "Your saved channels.", "Favourites"], recent: ["Recently played", "Pick up where you left off.", "Recently played"] };
    const [title, subtitle, listTitle] = labels[state.view] || labels.live;
    els.title.textContent = title; els.subtitle.textContent = subtitle;
    els.listTitle.textContent = state.view === "live" && state.category !== "All" ? state.category : listTitle;
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
    els.categoryList.querySelectorAll(".category").forEach((b) => b.classList.toggle("active", b.dataset.category === state.category));
  }
  function currentList() {
    let list = state.channels;
    if (state.view === "favorites") list = list.filter((c) => state.favorites.has(c.id));
    else if (state.view === "recent") list = state.recent.map((id) => state.byId.get(id)).filter(Boolean);
    else if (state.category !== "All") list = list.filter((c) => c.group === state.category);
    const terms = els.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length ? list.filter((c) => terms.every((t) => c.search.includes(t))) : list;
  }

  const sentinel = Object.assign(document.createElement("div"), { className: "list-sentinel" });
  sentinel.style.height = "1px";
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { state.limit += CONFIG.pageSize; appendRows(); } }, { rootMargin: "600px" })
    : null;
  if (!io) state.limit = Infinity;

  function renderChannels() {
    state.filtered = currentList(); state.rendered = 0; state.limit = io ? CONFIG.pageSize : Infinity;
    const n = state.filtered.length;
    els.channelCount.textContent = `${n.toLocaleString()} channel${n === 1 ? "" : "s"}`;
    io?.unobserve(sentinel); els.channelList.textContent = "";
    if (!n) {
      const msg = state.channels.length ? "No matching channels" : "No channels yet";
      const detail = state.channels.length ? "Try another search or category." : "Add an M3U playlist to get started.";
      els.channelList.innerHTML = `<div class="empty-state"><div>▤</div><strong>${msg}</strong><p>${detail}</p></div>`; return;
    }
    appendRows();
  }
  function appendRows() {
    const list = state.filtered, end = Math.min(state.limit, list.length), frag = document.createDocumentFragment();
    sentinel.remove(); io?.unobserve(sentinel);
    for (let i = state.rendered; i < end; i++) frag.appendChild(rowFor(list[i]));
    state.rendered = Math.max(state.rendered, end); els.channelList.appendChild(frag);
    if (state.rendered < list.length && io) { els.channelList.appendChild(sentinel); io.observe(sentinel); }
  }
  function fallbackLogo(ch) { const d = document.createElement("div"); d.className = "channel-logo"; d.textContent = initials(ch.name); return d; }
  function logoEl(ch) {
    if (!ch.logo) return fallbackLogo(ch);
    const img = document.createElement("img"); let retried = false;
    img.className = "channel-logo"; img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      if (!retried && /^http:/i.test(img.src)) { retried = true; img.src = img.src.replace(/^http:/i, "https:"); }
      else img.replaceWith(fallbackLogo(ch));
    };
    img.src = ch.logo; return img;
  }
  function rowFor(ch) {
    const row = document.createElement("button"); row.type = "button"; row.dataset.id = ch.id;
    row.className = "channel-row" + (state.current?.id === ch.id ? " selected" : "");
    row.setAttribute("aria-label", `Play ${ch.name}`);
    const text = document.createElement("div"); text.className = "channel-text";
    const name = document.createElement("strong"); name.textContent = ch.name;
    const meta = document.createElement("small"); meta.textContent = ch.group || "Other";
    text.append(name, meta);
    const star = document.createElement("span"); star.className = "row-star" + (state.favorites.has(ch.id) ? " on" : "");
    star.textContent = state.favorites.has(ch.id) ? "★" : "☆"; star.title = "Toggle favourite";
    row.append(logoEl(ch), text, star); return row;
  }
  function markSelected() {
    els.channelList.querySelectorAll(".channel-row.selected").forEach((r) => r.classList.remove("selected"));
    if (state.current) els.channelList.querySelector(`.channel-row[data-id="${state.current.id}"]`)?.classList.add("selected");
  }
  function revealCurrent() {
    const i = state.filtered.indexOf(state.current);
    if (i < 0) return;
    if (i >= state.rendered) { state.limit = i + 1; appendRows(); }
    els.channelList.querySelector(`.channel-row[data-id="${state.current.id}"]`)?.scrollIntoView({ block: "nearest" });
  }
  function zap(dir) {
    const list = state.filtered; if (!list.length) return;
    const i = list.findIndex((c) => c.id === state.current?.id);
    const next = i < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[(i + dir + list.length) % list.length];
    playChannel(next); revealCurrent();
  }

  function toggleFavorite(ch = state.current) {
    if (!ch) return toast("Select a channel first.");
    state.favorites.has(ch.id) ? state.favorites.delete(ch.id) : state.favorites.add(ch.id);
    store.set("fav", [...state.favorites]);
    if (state.current?.id === ch.id && els.nowFav) els.nowFav.textContent = state.favorites.has(ch.id) ? "★" : "☆";
    if (state.view === "favorites") return renderChannels();
    const star = els.channelList.querySelector(`.channel-row[data-id="${ch.id}"] .row-star`);
    if (star) { const f = state.favorites.has(ch.id); star.textContent = f ? "★" : "☆"; star.classList.toggle("on", f); }
  }
  function navigate(view) { state.view = view; if (view !== "live") state.category = "All"; updatePage(); renderChannels(); }

  /* ================= injected player UI ================= */
  const wrap = els.video.parentElement;
  const style = document.createElement("style");
  style.textContent = `
    .ctl-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 0}
    .ctl-bar button,.ctl-bar select{background:rgba(127,127,127,.18);color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer}
    .ctl-bar button:hover,.ctl-bar select:hover{background:rgba(127,127,127,.32)}
    .ctl-bar button:focus-visible,.ctl-bar select:focus-visible{outline:2px solid currentColor;outline-offset:2px}
    .ctl-status{margin-left:auto;font-size:.8em;opacity:.7}
    .ctl-loading{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none}
    .ctl-loading.show{display:flex}
    .ctl-loading i{width:42px;height:42px;border:4px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:ctlspin .8s linear infinite}
    @keyframes ctlspin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.ctl-loading i{animation-duration:2.5s}}
    .row-star{margin-left:auto;padding:0 6px;cursor:pointer}.row-star:not(.on){opacity:.3}`;
  document.head.appendChild(style);
  if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
  const spinner = document.createElement("div"); spinner.className = "ctl-loading"; spinner.innerHTML = "<i></i>"; wrap.appendChild(spinner);

  const bar = document.createElement("div"); bar.className = "ctl-bar";
  bar.innerHTML = `
    <button data-act="prev" title="Previous channel (B)" aria-label="Previous channel">⏮</button>
    <button data-act="next" title="Next channel (N)" aria-label="Next channel">⏭</button>
    <button data-act="retry" title="Reload stream (R)" aria-label="Reload stream">⟳</button>
    <button data-act="mute" title="Mute (M)" aria-label="Mute">🔊</button>
    <select id="ctlMode" title="Buffer mode: Smooth = fewest stalls (more delay), Low delay = closest to live" aria-label="Buffer mode"></select>
    <select id="ctlQuality" title="Quality" aria-label="Quality" style="display:none"></select>
    <button data-act="pip" title="Picture in picture (P)">PiP</button>
    <button data-act="fs" title="Fullscreen (F)" aria-label="Fullscreen">⛶</button>
    <button data-act="copy" title="Copy stream URL" aria-label="Copy stream URL">🔗</button>
    <span class="ctl-status" id="ctlStatus" aria-live="polite"></span>`;
  wrap.insertAdjacentElement("afterend", bar);
  const qualitySel = $("ctlQuality"), statusEl = $("ctlStatus"), muteBtn = bar.querySelector('[data-act="mute"]');
  const setStatus = (t) => { statusEl.textContent = t || ""; };
  const showLoading = (on_) => spinner.classList.toggle("show", !!on_);
  const modeSel = $("ctlMode");
  Object.entries(PROFILES).forEach(([k, p]) => modeSel.add(new Option(p.label, k)));
  modeSel.value = mode;
  on(modeSel, "change", () => {
    mode = modeSel.value; store.set("mode", mode); toast(`Buffer mode: ${profile().label}`);
    if (state.current) playChannel(state.current, { retry: true });
  });

  const v = els.video;
  v.controls = true; v.playsInline = true; v.preload = "auto";
  v.volume = store.get("vol", 1); v.muted = store.get("muted", false);

  function act(name) {
    if (name === "prev") zap(-1);
    else if (name === "next") zap(1);
    else if (name === "retry") { if (state.current) { state.retries = 0; playChannel(state.current, { retry: true }); } }
    else if (name === "mute") v.muted = !v.muted;
    else if (name === "pip") (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture?.())?.catch?.(() => toast("Picture-in-picture isn't available."));
    else if (name === "fs") {
      if (document.fullscreenElement) document.exitFullscreen();
      else (wrap.requestFullscreen ? wrap.requestFullscreen() : v.webkitEnterFullscreen?.());
    } else if (name === "copy") {
      if (!state.current) return toast("Select a channel first.");
      navigator.clipboard?.writeText(state.current.url).then(() => toast("Stream URL copied"), () => toast("Couldn't copy."));
    }
  }
  on(bar, "click", (e) => { const b = e.target.closest("[data-act]"); if (b) act(b.dataset.act); });
  on(qualitySel, "change", () => { const h = state.engine?.hls; if (h) h.currentLevel = +qualitySel.value; });
  function setLevels(hls) {
    qualitySel.textContent = "";
    const opts = [["-1", "Auto"], ...hls.levels.map((l, i) => [String(i), l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)}k`]).reverse()];
    opts.forEach(([val, label]) => qualitySel.add(new Option(label, val)));
    qualitySel.style.display = hls.levels.length > 1 ? "" : "none";
  }

  /* ================= playback engines ================= */
  const ENGINES = {
    async hls(url, el, fail, o) {
      await loadLib("Hls", CONFIG.libs.hls);
      if (!Hls.isSupported()) throw new Error("HLS isn't supported by this browser engine");
      const hls = new Hls({
        enableWorker: true, ...profile().hls,
        manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4,
        xhrSetup: o.proxy ? (xhr, u) => xhr.open("GET", proxify(u), true) : undefined   // proxy every playlist + segment request
      });
      const rec = { net: 0, media: 0 };
      hls.on(Hls.Events.MANIFEST_PARSED, () => setLevels(hls));
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        const live = el.readyState >= 2;   // already playing → try to recover in place
        if (live && d.type === Hls.ErrorTypes.NETWORK_ERROR && rec.net++ < 3) return hls.startLoad();
        if (live && d.type === Hls.ErrorTypes.MEDIA_ERROR && rec.media++ < 3) return hls.recoverMediaError();
        fail(new Error(`HLS ${d.type}: ${d.details}`));
      });
      hls.loadSource(url); hls.attachMedia(el);
      return { hls, destroy: () => hls.destroy() };
    },
    async mpegts(url, el, fail) {
      await loadLib("mpegts", CONFIG.libs.mpegts);
      if (!mpegts.getFeatureList().mseLivePlayback) throw new Error("MPEG-TS (MSE) isn't supported by this browser");
      const p = mpegts.createPlayer({ type: /\.flv($|[?#])/i.test(url) ? "flv" : "mpegts", isLive: true, url },
        { enableWorker: true, ...profile().mpegts });
      p.attachMediaElement(el);
      p.on(mpegts.Events.ERROR, (type, detail) => fail(new Error(`${type}: ${detail}`)));
      p.load();
      return { destroy() { try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch {} } };
    },
    async dash(url, el, fail) {
      await loadLib("dashjs", CONFIG.libs.dash);
      const p = dashjs.MediaPlayer().create();
      p.on(dashjs.MediaPlayer.events.ERROR, (e) => fail(new Error(`DASH: ${e?.error?.message || "error"}`)));
      p.initialize(el, url, true);
      return { destroy() { try { p.reset(); } catch {} } };
    },
    async native(url, el) { el.src = url; el.load(); return { destroy() {} }; }
  };

  function buildPlan(url) {
    const path = url.split(/[?#]/)[0].toLowerCase();
    let engines;
    if (/\.m3u8?$/.test(path)) engines = ["hls", "native"];
    else if (/\.mpd$/.test(path)) engines = ["dash", "native"];
    else if (/\.(ts|flv)$/.test(path)) engines = ["mpegts", "native"];
    else if (/\.(mp4|m4v|webm|ogv|ogg|mov|mp3|aac|m4a)$/.test(path)) engines = ["native"];
    else engines = ["hls", "mpegts", "native"];      // extension-less URLs (Xtream-style): try everything
    const hint = state.hints.get(hostOf(url));
    if (hint && engines.includes(hint)) engines = [hint, ...engines.filter((e) => e !== hint)];
    const plan = [];
    for (const c of urlCandidates(url)) for (const engine of engines) plan.push({ engine, url: c.url, proxy: !!c.proxy });
    return plan;
  }

  function destroyEngine() {
    try { state.engine?.destroy?.(); } catch {}
    state.engine = null; v.onerror = null; v.pause(); v.removeAttribute("src"); v.load();
    qualitySel.style.display = "none";
  }
  const mediaError = (e) => ({ 1: "playback aborted", 2: "network error", 3: "decode error", 4: "unsupported source" }[e?.code] || "media error");

  // Starts one engine; resolves once the video has data, rejects on error/timeout.
  // After it has settled, later fatal errors are routed to the retry logic.
  function startEngine(stepInfo, tok) {
    return new Promise((resolve, reject) => {
      let settled = false, timer = 0;
      const okEv = () => finish();
      const finish = (err) => {
        if (settled) { if (err && tok === playToken) onRuntimeError(err); return; }
        settled = true; clearTimeout(timer);
        v.removeEventListener("playing", okEv); v.removeEventListener("loadeddata", okEv);
        err ? reject(err) : resolve();
      };
      timer = setTimeout(() => finish(new Error("stream timed out")), CONFIG.startTimeout);
      v.addEventListener("playing", okEv); v.addEventListener("loadeddata", okEv);
      v.onerror = () => finish(new Error(mediaError(v.error)));
      const target = stepInfo.proxy && stepInfo.engine !== "hls" ? proxify(stepInfo.url) : stepInfo.url;
      ENGINES[stepInfo.engine](target, v, finish, stepInfo).then((inst) => {
        if (tok !== playToken) { inst?.destroy?.(); return finish(new Error("cancelled")); }
        state.engine = inst; v.play().catch(() => {});
      }).catch(finish);
    });
  }

  async function playChannel(channel, { retry = false } = {}) {
    if (!channel?.url) return;
    const tok = ++playToken;
    clearTimeout(state.retryTimer); clearTimeout(state.stallTimer);
    if (!retry) {
      state.retries = 0;
      state.recent = [channel.id, ...state.recent.filter((id) => id !== channel.id)].slice(0, 30); store.set("recent", state.recent);
    }
    state.current = channel; state.playing = false; state.holding = false; state.stalls = [];
    updateNowPlaying(); markSelected();
    els.placeholder.classList.add("hidden"); els.videoError.classList.add("hidden"); showLoading(true);
    destroyEngine();

    let lastErr;
    for (const s of buildPlan(channel.url)) {
      if (tok !== playToken) return;
      setStatus(`Connecting · ${LABELS[s.engine]}${s.proxy ? " (proxy)" : ""}…`);
      try {
        await startEngine(s, tok);
        if (tok !== playToken) return;
        state.hints.set(hostOf(channel.url), s.engine);
        state.label = LABELS[s.engine] + (s.proxy ? " · proxy" : ""); updateNowPlaying(LABELS[s.engine]);
        const P = profile();   // build a small cushion first so playback doesn't stutter right after starting
        if (P.prebuffer && bufferAhead() < P.prebuffer) await holdUntilBuffered(P.prebuffer, CONFIG.prebufferMax, tok);
        if (tok !== playToken) return;
        state.playing = true; showLoading(false);
        if (v.paused) v.play().catch((e) => { if (e.name === "NotAllowedError") { v.muted = true; v.play().catch(() => toast("Press play to start.")); } });
        return;
      } catch (e) {
        if (tok !== playToken) return;
        lastErr = e; destroyEngine();
      }
    }
    showLoading(false); setStatus("Failed"); playbackError(explain(lastErr, channel.url));
  }

  function onRuntimeError(err) {
    if (!state.current) return;
    if (state.retries >= CONFIG.maxRetries) { showLoading(false); setStatus("Failed"); return playbackError(explain(err, state.current.url)); }
    const delay = Math.min(1000 * 2 ** state.retries, 8000); state.retries++;
    toast(`Stream interrupted. Reconnecting (${state.retries}/${CONFIG.maxRetries})…`);
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => playChannel(state.current, { retry: true }), delay);
  }
  function explain(err, url) {
    const mixed = location.protocol === "https:" && /^http:/i.test(url) && !CONFIG.proxy;
    return `Couldn't play this channel (${err?.message || "unknown error"}). ` +
      (mixed ? "It uses plain HTTP and this page is HTTPS, so the browser blocks it unless the server also offers HTTPS. Open this player over http:// or set a proxy with ?proxy=. " : "") +
      "It may be offline, geo-blocked, need a login or custom headers, lack CORS support, or use a codec your browser can't decode. Press R to retry.";
  }
  function playbackError(message) { els.videoError.textContent = message; els.videoError.classList.remove("hidden"); }
  function stopPlayback() {
    playToken++; clearTimeout(state.retryTimer); clearTimeout(state.stallTimer); state.playing = false; state.holding = false;
    destroyEngine(); showLoading(false); setStatus("");
    els.placeholder.classList.remove("hidden"); els.videoError.classList.add("hidden"); document.title = baseTitle;
  }
  function updateNowPlaying(engineLabel) {
    const c = state.current; if (!c) return;
    els.nowTitle.textContent = c.name;
    els.nowMeta.textContent = [c.group || "Other", c.tvgId, engineLabel].filter(Boolean).join(" · ");
    els.nowAvatar.textContent = initials(c.name);
    if (els.nowFav) els.nowFav.textContent = state.favorites.has(c.id) ? "★" : "☆";
    document.title = `${c.name} · ${baseTitle}`;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: c.name, artist: c.group || "Live TV", artwork: c.logo ? [{ src: c.logo }] : [] }); } catch {}
  }

  /* ---------- anti-buffering logic ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Seconds of video buffered ahead of the playhead.
  function bufferAhead() {
    const t = v.currentTime, b = v.buffered;
    for (let i = 0; i < b.length; i++) if (b.end(i) >= t && b.start(i) - t < 1.5) return b.end(i) - Math.max(t, b.start(i));
    return 0;
  }
  // If the playhead sits in a tiny gap between buffered ranges, jump over it.
  function nudge() {
    const t = v.currentTime, b = v.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t && t <= b.end(i)) return false;
    for (let i = 0; i < b.length; i++) if (b.start(i) > t && b.start(i) - t < 2) { v.currentTime = b.start(i) + 0.05; return true; }
    return false;
  }
  // Pause until `secs` are buffered (or maxMs passed with some data), then resume.
  async function holdUntilBuffered(secs, maxMs, tok) {
    if (state.holding) return;
    state.holding = true; showLoading(true); if (!v.paused) v.pause();
    const t0 = Date.now();
    while (tok === playToken && state.holding) {
      if (!v.paused) { state.holding = false; return; }          // someone pressed play
      const ahead = bufferAhead();
      if (ahead >= secs || (Date.now() - t0 > maxMs && ahead >= 0.5)) break;
      setStatus(`Buffering ${ahead.toFixed(0)}/${secs}s…`); await sleep(300);
    }
    if (tok !== playToken || !state.holding) return;
    state.holding = false; v.play().catch(() => {});
  }
  // Two stalls within a minute → cap the HLS quality one step lower.
  function noteStall() {
    const now = Date.now(); state.stalls = state.stalls.filter((t) => now - t < 60000); state.stalls.push(now);
    const h = state.engine?.hls;
    if (state.stalls.length >= 2 && h && h.autoLevelEnabled && h.levels.length > 1) {
      const cur = h.currentLevel >= 0 ? h.currentLevel : h.loadLevel;
      if (cur > 0) { h.autoLevelCapping = cur - 1; state.stalls = []; toast("Connection is slow. Lowering quality to keep it smooth."); }
    }
  }
  on(v, "waiting", () => {
    if (!state.playing || state.holding) return;
    showLoading(true);
    clearTimeout(state.stallTimer); state.stallTimer = setTimeout(() => onRuntimeError(new Error("stream stalled")), CONFIG.stallTimeout);
    if (nudge()) return;
    noteStall();
    const c = profile().cushion; if (c) holdUntilBuffered(c, 12000, playToken);
  });
  on(v, "playing", () => { clearTimeout(state.stallTimer); if (!state.holding) showLoading(false); });
  on(v, "canplay", () => { if (!state.holding) showLoading(false); });
  on(v, "pause", () => { if (!state.holding) { clearTimeout(state.stallTimer); showLoading(false); } });
  on(v, "ended", () => clearTimeout(state.stallTimer));
  setInterval(() => { if (state.playing && !state.holding && state.label) setStatus(`${state.label} · ${bufferAhead().toFixed(0)}s buffered`); }, 1000);

  // Volume persistence
  on(v, "volumechange", () => { store.set("vol", v.volume); store.set("muted", v.muted); muteBtn.textContent = v.muted || v.volume === 0 ? "🔇" : "🔊"; });
  muteBtn.textContent = v.muted ? "🔇" : "🔊";
  try {
    navigator.mediaSession.setActionHandler("previoustrack", () => zap(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => zap(1));
  } catch {}

  /* ================= saved playlists + export ================= */
  const slim = () => state.channels.map(({ name, group, logo, tvgId, url }) => ({ name, group, logo, tvgId, url }));
  const savedList = () => store.get("playlists", []);
  const cleanName = () => (state.playlistName || "").replace(/ \(saved\)$/, "");

  const svStyle = document.createElement("style");
  svStyle.textContent = `
    #savedDialog{color-scheme:light dark;background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.4);border-radius:14px;padding:0;width:min(520px,92vw);max-height:80vh}
    #savedDialog::backdrop{background:rgba(0,0,0,.55)}
    .sv-body{padding:16px}
    .sv-head,.sv-row,.sv-item{display:flex;gap:8px;align-items:center}
    .sv-head{justify-content:space-between;margin-bottom:10px}.sv-row{margin-bottom:10px;flex-wrap:wrap}
    #savedDialog input{flex:1;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit}
    #savedDialog button{background:rgba(127,127,127,.18);color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:7px 12px;font:inherit;cursor:pointer}
    #savedDialog button:hover{background:rgba(127,127,127,.32)}
    .sv-list{overflow:auto;max-height:46vh;border-top:1px solid rgba(127,127,127,.25);padding-top:8px}
    .sv-item{padding:8px 0;border-bottom:1px solid rgba(127,127,127,.15)}
    .sv-item div{flex:1;min-width:0}.sv-item small{display:block;opacity:.65}
    .sv-item strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sv-empty{opacity:.65;padding:10px 0}`;
  document.head.appendChild(svStyle);

  const savedDlg = document.createElement("dialog"); savedDlg.id = "savedDialog";
  savedDlg.innerHTML = `<div class="sv-body">
    <div class="sv-head"><strong>Saved playlists</strong><button type="button" data-sv="close" aria-label="Close">✕</button></div>
    <div class="sv-row"><input id="svName" type="text" maxlength="60" placeholder="Name this playlist" aria-label="Playlist name"><button type="button" data-sv="save">Save current</button></div>
    <div class="sv-row"><button type="button" data-sv="export">Export all (.m3u)</button><button type="button" data-sv="exportFav">Export favourites (.m3u)</button></div>
    <div id="svList" class="sv-list"></div></div>`;
  document.body.appendChild(savedDlg);

  function saveCurrent(name) {
    if (!state.channels.length) return toast("Load a playlist first.");
    name = (name || "").trim() || cleanName() || "My playlist";
    const list = savedList(), old = list.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const id = old?.id || hash(name + Date.now());
    const entry = { id, name, source: state.source || { type: "file" }, count: state.channels.length, ts: Date.now() };
    const cached = store.set("pl:" + id, { channels: slim() });
    if (!cached) store.del("pl:" + id);
    if (!cached && entry.source.type !== "url") return toast("Too large to store in the browser. Use Export (.m3u) instead.");
    store.set("playlists", [entry, ...list.filter((p) => p.id !== id)]);
    toast(cached ? `Saved "${name}"` : `Saved the link for "${name}" (too large to keep offline)`);
    renderSaved();
  }
  function loadSaved(id) {
    const e = savedList().find((p) => p.id === id); if (!e) return;
    const data = store.get("pl:" + id, null);
    if (!data?.channels?.length && e.source?.type !== "url") return toast("This playlist's data is no longer stored. Re-import the file.");
    savedDlg.close();
    if (data?.channels?.length) {
      stopPlayback(); state.current = null;
      setChannels(data.channels.map(makeChannel), e.name); state.source = e.source; persistPlaylist(e.name, e.source);
      toast(`Loaded "${e.name}"`);
    } else { els.file.value = ""; els.url.value = e.source.url; readPlaylist(); }
  }
  function exportM3U(onlyFavs) {
    const list = onlyFavs ? state.channels.filter((c) => state.favorites.has(c.id)) : state.channels;
    if (!list.length) return toast(onlyFavs ? "No favourites to export yet." : "Load a playlist first.");
    const q = (x) => String(x || "").replace(/["\r\n]+/g, " ").trim();
    const text = "#EXTM3U\n" + list.map((c) => `#EXTINF:-1 tvg-id="${q(c.tvgId)}" tvg-logo="${q(c.logo)}" group-title="${q(c.group)}",${q(c.name)}\n${c.url}`).join("\n") + "\n";
    const base = cleanName().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "playlist";
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([text], { type: "audio/x-mpegurl" })), download: `${base}${onlyFavs ? "-favourites" : ""}.m3u` });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`Exported ${list.length.toLocaleString()} channels`);
  }
  function renderSaved() {
    const box = $("svList"), list = savedList(); box.textContent = "";
    if (!list.length) { const d = document.createElement("div"); d.className = "sv-empty"; d.textContent = 'Nothing saved yet. Load a playlist, then press "Save current".'; box.appendChild(d); return; }
    for (const p of list) {
      const item = document.createElement("div"); item.className = "sv-item";
      const info = document.createElement("div"), n = document.createElement("strong"), m = document.createElement("small");
      n.textContent = p.name; n.title = p.source?.url || p.name;
      m.textContent = `${p.count.toLocaleString()} channels · ${p.source?.type === "url" ? hostOf(p.source.url) : "file"} · ${new Date(p.ts).toLocaleDateString()}`;
      info.append(n, m);
      const load = document.createElement("button"), del = document.createElement("button");
      load.type = "button"; del.type = "button"; load.textContent = "Load"; del.textContent = "Delete";
      load.dataset.sv = "load"; del.dataset.sv = "delete"; load.dataset.id = p.id; del.dataset.id = p.id;
      del.setAttribute("aria-label", `Delete ${p.name}`);
      item.append(info, load, del); box.appendChild(item);
    }
  }
  on(savedDlg, "click", (e) => {
    if (e.target === savedDlg) return savedDlg.close();     // backdrop click
    const b = e.target.closest("[data-sv]"); if (!b) return;
    const a = b.dataset.sv;
    if (a === "close") savedDlg.close();
    else if (a === "save") saveCurrent($("svName").value);
    else if (a === "export") exportM3U(false);
    else if (a === "exportFav") exportM3U(true);
    else if (a === "load") loadSaved(b.dataset.id);
    else if (a === "delete" && confirm("Delete this saved playlist?")) {
      store.del("pl:" + b.dataset.id); store.set("playlists", savedList().filter((p) => p.id !== b.dataset.id)); renderSaved();
    }
  });
  on($("svName"), "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveCurrent(e.target.value); } });
  const openBtn = document.createElement("button"); openBtn.type = "button"; openBtn.textContent = "💾 Playlists";
  const loadBtn = $("loadPlaylistBtn");
  if (loadBtn) { openBtn.className = loadBtn.className; loadBtn.insertAdjacentElement("afterend", openBtn); } else bar.appendChild(openBtn);
  on(openBtn, "click", () => { $("svName").value = cleanName(); renderSaved(); savedDlg.showModal(); });

  /* ================= events ================= */
  ["loadPlaylistBtn", "topLoadBtn", "placeholderLoadBtn"].forEach((id) => on($(id), "click", openDialog));
  on($("playlistForm"), "submit", (e) => { e.preventDefault(); readPlaylist(); });
  on(els.nowFav, "click", () => toggleFavorite());
  on($("refreshBtn"), "click", () => {
    if (state.source?.type === "url") { els.file.value = ""; els.url.value = state.source.url; toast("Reloading playlist…"); readPlaylist(); }
    else { els.search.value = ""; renderChannels(); }
  });
  on(els.search, "input", () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(renderChannels, 150); });
  on(els.channelList, "click", (e) => {
    const row = e.target.closest(".channel-row"); if (!row) return;
    const ch = state.byId.get(row.dataset.id); if (!ch) return;
    e.target.closest(".row-star") ? toggleFavorite(ch) : playChannel(ch);
  });
  on(els.categoryList, "click", (e) => {
    const b = e.target.closest(".category"); if (!b) return;
    state.category = b.dataset.category; state.view = "live"; updatePage(); renderChannels();
    if (window.innerWidth < 760) $("sidebar")?.classList.remove("open");
  });
  document.querySelectorAll(".nav-item").forEach((btn) => on(btn, "click", () => { navigate(btn.dataset.view); if (window.innerWidth < 760) $("sidebar")?.classList.remove("open"); }));
  on($("menuBtn"), "click", () => $("sidebar")?.classList.toggle("open"));

  on(document, "keydown", (e) => {
    if (e.key === "Escape") $("sidebar")?.classList.remove("open");
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === "/") { e.preventDefault(); els.search.focus(); }
    else if (k === "n") act("next"); else if (k === "b") act("prev");
    else if (k === "m") act("mute"); else if (k === "f") act("fs");
    else if (k === "p") act("pip"); else if (k === "r") act("retry");
    else if (k === "k" || (k === " " && document.activeElement === document.body)) { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); }
  });
  // Drag & drop an .m3u / .m3u8 file anywhere on the page
  on(window, "dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
  on(window, "drop", async (e) => {
    const f = e.dataTransfer?.files?.[0]; if (!f) return; e.preventDefault();
    try { loadText(await f.text(), "", f.name, { type: "file", name: f.name }); } catch (err) { toast(err.message); }
  });
  on(window, "online", () => { toast("Back online"); if (state.current && !state.playing) playChannel(state.current, { retry: true }); });
  on(window, "offline", () => toast("You're offline."));

  /* ================= startup ================= */
  renderHistory(); updatePage(); renderChannels();
  const preset = qs.get("playlist");
  const cached = store.get("channels", null);
  if (preset) { els.url.value = preset; readPlaylist(); }
  else if (cached?.channels?.length) {
    setChannels(cached.channels.map(makeChannel), `${cached.name} (saved)`);
    state.source = store.get("source", null);
  }
})();
