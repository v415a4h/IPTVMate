(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { channels: [], filtered: [], category: "All", view: "live", current: null, hls: null, favorites: new Set(), recent: [], playlistName: "", toastTimer: null };
  const els = {
    video: $("video"), placeholder: $("videoPlaceholder"), videoError: $("videoError"),
    channelList: $("channelList"), categoryList: $("categoryList"), channelCount: $("channelCount"),
    playlistStatus: $("playlistStatus"), search: $("searchInput"), title: $("pageTitle"),
    subtitle: $("pageSubtitle"), listTitle: $("listTitle"), nowTitle: $("nowTitle"),
    nowMeta: $("nowMeta"), nowAvatar: $("nowAvatar"), nowFav: $("nowFavBtn"),
    dialog: $("playlistDialog"), url: $("playlistUrl"), file: $("playlistFile"),
    dialogError: $("dialogError"), importBtn: $("importBtn"), toast: $("toast")
  };

  function toast(message) {
    els.toast.textContent = message; els.toast.classList.add("show");
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
  }
  function openDialog() { els.dialogError.classList.add("hidden"); els.dialog.showModal(); }
  function safeText(value) { return String(value || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
  function normalizeUrl(value, base) {
    try { return new URL(value, base || window.location.href).href; } catch { return value; }
  }
  function parseAttributes(line) {
    const attrs = {};
    const re = /([\w-]+)="([^"]*)"/g; let match;
    while ((match = re.exec(line))) attrs[match[1].toLowerCase()] = match[2];
    return attrs;
  }
  function parseM3U(text, baseUrl) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const channels = []; let current = null;
    for (const raw of lines) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith("#EXTINF")) {
        const comma = line.indexOf(",");
        const meta = comma >= 0 ? line.slice(0, comma) : line;
        const name = comma >= 0 ? line.slice(comma + 1).trim() : "Unknown channel";
        const attrs = parseAttributes(meta);
        const groupMatch = meta.match(/group-title="([^"]*)"/i);
        current = { id: `ch-${channels.length}-${Math.random().toString(36).slice(2,7)}`, name: name || attrs["tvg-name"] || "Unknown channel",
          group: (groupMatch && groupMatch[1]) || "Other", logo: attrs["tvg-logo"] || "", tvgId: attrs["tvg-id"] || "", url: "", rawUrl: "" };
      } else if (line.startsWith("#")) {
        continue;
      } else if (current) {
        current.rawUrl = line;
        current.url = normalizeUrl(line, baseUrl);
        if (/^https?:\/\//i.test(current.url)) channels.push(current);
        current = null;
      }
    }
    return channels;
  }
  async function readPlaylist() {
    els.dialogError.classList.add("hidden");
    const file = els.file.files && els.file.files[0];
    const url = els.url.value.trim();
    if (!file && !url) { showDialogError("Enter a playlist URL or choose a local M3U file."); return; }
    els.importBtn.disabled = true; els.importBtn.textContent = "Loading…";
    try {
      let text, base = "";
      if (file) { text = await file.text(); state.playlistName = file.name; }
      else {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS playlist URLs are supported.");
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Playlist request failed (HTTP ${response.status}).`);
        text = await response.text(); base = response.url || url; state.playlistName = parsed.hostname;
      }
      const channels = parseM3U(text, base);
      if (!channels.length) throw new Error("No playable HTTP/HTTPS channel URLs found. Check that this is an M3U playlist.");
      state.channels = channels;
      state.category = "All"; state.view = "live"; state.current = null;
      els.search.value = "";
      els.dialog.close(); stopPlayback(); renderCategories(); updatePage(); renderChannels();
      els.playlistStatus.textContent = `${channels.length.toLocaleString()} channels · ${state.playlistName}`;
      toast(`Loaded ${channels.length} channels`);
    } catch (error) {
      showDialogError(`${error.message || "Could not load playlist."}${!els.file.files?.[0] ? " If this is a URL, the server may block browser CORS requests." : ""}`);
    } finally { els.importBtn.disabled = false; els.importBtn.textContent = "Load playlist"; }
  }
  function showDialogError(message) { els.dialogError.textContent = message; els.dialogError.classList.remove("hidden"); }
  function renderCategories() {
    const groups = [...new Set(state.channels.map(c => c.group || "Other"))].sort((a,b) => a.localeCompare(b));
    els.categoryList.innerHTML = "";
    const make = (label, value, count) => {
      const btn = document.createElement("button"); btn.className = `category ${state.category === value ? "active" : ""}`;
      btn.dataset.category = value; btn.textContent = label; btn.title = count == null ? label : `${label} (${count})`;
      btn.addEventListener("click", () => { state.category = value; state.view = "live"; updatePage(); renderCategories(); renderChannels(); if (window.innerWidth < 760) $("sidebar").classList.remove("open"); });
      els.categoryList.appendChild(btn);
    };
    make(`All channels (${state.channels.length})`, "All", state.channels.length);
    groups.forEach(group => make(group, group, state.channels.filter(c => c.group === group).length));
  }
  function updatePage() {
    const labels = {live:["Live TV","Your channels, all in one place.","Channels"],favorites:["Favourites","Your saved channels.","Favourites"],recent:["Recently played","Pick up where you left off.","Recently played"]};
    const [title, subtitle, listTitle] = labels[state.view] || labels.live;
    els.title.textContent = title; els.subtitle.textContent = subtitle; els.listTitle.textContent = state.view === "live" && state.category !== "All" ? state.category : listTitle;
    document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  }
  function currentList() {
    let list = state.channels;
    if (state.view === "favorites") list = list.filter(c => state.favorites.has(c.id));
    if (state.view === "recent") list = state.recent.map(id => state.channels.find(c => c.id === id)).filter(Boolean);
    if (state.view === "live" && state.category !== "All") list = list.filter(c => c.group === state.category);
    const q = els.search.value.trim().toLowerCase();
    if (q) list = list.filter(c => `${c.name} ${c.group} ${c.tvgId}`.toLowerCase().includes(q));
    return list;
  }
  function renderChannels() {
    const list = currentList(); state.filtered = list;
    els.channelCount.textContent = `${list.length.toLocaleString()} channel${list.length === 1 ? "" : "s"}`;
    els.channelList.innerHTML = "";
    if (!list.length) {
      const msg = state.channels.length ? "No matching channels" : "No channels yet";
      const detail = state.channels.length ? "Try another search or category." : "Add an M3U playlist to get started.";
      els.channelList.innerHTML = `<div class="empty-state"><div>▤</div><strong>${msg}</strong><p>${detail}</p></div>`; return;
    }
    const fragment = document.createDocumentFragment();
    list.forEach(channel => {
      const row = document.createElement("button"); row.className = `channel-row ${state.current?.id === channel.id ? "selected" : ""}`;
      row.setAttribute("aria-label", `Play ${channel.name}`);
      const logo = document.createElement(channel.logo ? "img" : "div"); logo.className = "channel-logo";
      if (channel.logo) { logo.src = channel.logo; logo.alt = ""; logo.loading = "lazy"; logo.onerror = () => { const fallback = document.createElement("div"); fallback.className = "channel-logo"; fallback.textContent = initials(channel.name); logo.replaceWith(fallback); }; }
      else logo.textContent = initials(channel.name);
      const text = document.createElement("div"); text.className = "channel-text";
      const name = document.createElement("strong"); name.textContent = channel.name;
      const meta = document.createElement("small"); meta.textContent = channel.group || "Other";
      text.append(name, meta);
      const star = document.createElement("span"); star.className = "row-star"; star.textContent = state.favorites.has(channel.id) ? "★" : "";
      row.append(logo, text, star); row.addEventListener("click", () => playChannel(channel)); fragment.appendChild(row);
    });
    els.channelList.appendChild(fragment);
  }
  function initials(name) { return (name || "TV").trim().split(/\s+/).slice(0,2).map(s => s[0] || "").join("").toUpperCase(); }
  function stopPlayback() {
    if (state.hls) { state.hls.destroy(); state.hls = null; }
    els.video.pause(); els.video.removeAttribute("src"); els.video.load();
    els.placeholder.classList.remove("hidden"); els.videoError.classList.add("hidden");
  }
  function playbackError(message) {
    els.videoError.textContent = message; els.videoError.classList.remove("hidden");
  }
  function playChannel(channel) {
    if (!channel?.url) return;
    state.current = channel;
    state.recent = [channel.id, ...state.recent.filter(id => id !== channel.id)].slice(0, 30);
    els.nowTitle.textContent = channel.name; els.nowMeta.textContent = `${channel.group || "Other"}${channel.tvgId ? " · " + channel.tvgId : ""}`;
    els.nowAvatar.textContent = initials(channel.name); els.nowFav.textContent = state.favorites.has(channel.id) ? "★" : "☆";
    els.placeholder.classList.add("hidden"); els.videoError.classList.add("hidden");
    if (state.hls) { state.hls.destroy(); state.hls = null; }
    els.video.pause(); els.video.removeAttribute("src"); els.video.load();
    const isHls = /\.m3u8($|[?#])/i.test(channel.url) || channel.url.toLowerCase().includes(".m3u8?");
    if (isHls && window.Hls && Hls.isSupported()) {
      state.hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      state.hls.loadSource(channel.url); state.hls.attachMedia(els.video);
      state.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) playbackError("Playback failed. This stream may require CORS access, authentication, or unsupported headers."); });
    } else {
      els.video.src = channel.url;
      els.video.onerror = () => playbackError("The browser could not play this stream. It may be unsupported, offline, or blocked by CORS.");
    }
    els.video.play().then(() => {}).catch(() => toast("Press Play in the video controls if playback did not start."));
    renderChannels();
  }
  function toggleFavorite() {
    if (!state.current) return toast("Select a channel first.");
    if (state.favorites.has(state.current.id)) state.favorites.delete(state.current.id); else state.favorites.add(state.current.id);
    els.nowFav.textContent = state.favorites.has(state.current.id) ? "★" : "☆";
    renderChannels();
  }
  function navigate(view) { state.view = view; if (view !== "live") state.category = "All"; updatePage(); renderCategories(); renderChannels(); }
  $("loadPlaylistBtn").addEventListener("click", openDialog);
  $("topLoadBtn").addEventListener("click", openDialog);
  $("placeholderLoadBtn").addEventListener("click", openDialog);
  $("playlistForm").addEventListener("submit", e => { e.preventDefault(); readPlaylist(); });
  $("nowFavBtn").addEventListener("click", toggleFavorite);
  $("refreshBtn").addEventListener("click", () => { els.search.value = ""; renderChannels(); });
  els.search.addEventListener("input", renderChannels);
  document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => { navigate(btn.dataset.view); if (window.innerWidth < 760) $("sidebar").classList.remove("open"); }));
  $("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") $("sidebar").classList.remove("open");
    if (e.key === "/" && !["INPUT","TEXTAREA"].includes(document.activeElement.tagName)) { e.preventDefault(); els.search.focus(); }
  });
  // Optional URL parameter: ?playlist=https%3A%2F%2Fexample.com%2Fchannels.m3u
  const params = new URLSearchParams(location.search);
  const preset = params.get("playlist");
  if (preset) { els.url.value = preset; openDialog(); }
  updatePage(); renderChannels();
})();
