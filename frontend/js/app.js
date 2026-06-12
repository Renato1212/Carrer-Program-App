/* EdgeDesk frontend — vanilla JS, no build step. */
"use strict";

const SYMBOLS = ["ES","NQ","YM","RTY","CL","NG","GC","SI","HG","ZB","ZN","ZF","6E","6J","BTC"];
const TICKS = {ES:[0.25,12.5], NQ:[0.25,5], YM:[1,5], RTY:[0.1,5], CL:[0.01,10], NG:[0.001,10],
               GC:[0.1,10], SI:[0.005,25], HG:[0.0005,12.5], ZB:[0.03125,31.25], ZN:[0.015625,15.625],
               ZF:[0.0078125,7.8125], "6E":[0.00005,6.25], "6J":[0.0000005,6.25], BTC:[5,25]};
const state = { symbol: localStorage.getItem("edgedesk.symbol") || "ES", tab: "briefing",
                chart: null, series: null, interval: "5m", period: "5d", loaded: {}, nextEvent: null };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (n, d = 2) => n == null || isNaN(n) ? "—" : Number(n).toLocaleString("en-US", {maximumFractionDigits: d, minimumFractionDigits: 0});
const cls = n => n > 0 ? "up" : n < 0 ? "down" : "flat";
const sign = n => n > 0 ? "+" : "";
const errBox = (msg, hint = "") => `<div class="err">⚠ ${esc(msg)}${hint ? `<div class="mt8 muted">${esc(hint)}</div>` : ""}</div>`;

function hiDPI(cv) {
  const dpr = window.devicePixelRatio || 1;
  if (!cv.dataset.h) cv.dataset.h = cv.getAttribute("height") || cv.height || 300;
  const H = parseInt(cv.dataset.h, 10);
  const W = cv.clientWidth || 600;
  cv.style.height = H + "px";
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return {ctx, W, H};
}

async function api(path) {
  const r = await fetch("/api" + path);
  if (!r.ok) throw new Error(`server error ${r.status}`);
  return r.json();
}

/* ---------- shell ---------- */
function initShell() {
  const sel = $("#symbol-select");
  sel.innerHTML = SYMBOLS.map(s => `<option ${s === state.symbol ? "selected" : ""}>${s}</option>`).join("");
  sel.onchange = () => {
    state.symbol = sel.value;
    localStorage.setItem("edgedesk.symbol", state.symbol);
    state.loaded = {};
    const dp = $("#dom-panel");
    if (dp) { delete dp.dataset.init; dp.innerHTML = `<div class="loading">Loading DOM…</div>`; }
    updateHeaderQuote();
    loadTab(state.tab, true);
  };
  $$("#tabs button[data-tab]").forEach(b => b.onclick = () => {
    $$("#tabs button[data-tab]").forEach(x => x.classList.toggle("active", x === b));
    $$(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
    state.tab = b.dataset.tab;
    loadTab(state.tab);
  });
  setInterval(() => {
    $("#clock").textContent = new Date().toLocaleString("en-US", {timeZone: "America/New_York",
      hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit"}) + " ET";
    renderCountdown();
  }, 1000);
  updateHeaderQuote();
  setInterval(updateHeaderQuote, 15000);
  initCountdown();
}

function loadTab(tab, force = false) {
  const symScoped = ["briefing", "board", "profile", "trade"];
  const key = symScoped.includes(tab) ? `${tab}:${state.symbol}` : tab;
  if (!force && state.loaded[key]) return;
  state.loaded[key] = true;
  ({briefing: loadBriefing, board: loadBoard, profile: () => loadProfile(), calendar: loadCalendar,
    news: loadNews, macro: loadMacro, playbooks: loadPlaybooks, journal: loadJournal,
    trade: loadTrade}[tab])();
}

function loadMacro() {
  const sub = state.macroSub || "cb";
  ({cb: loadCB, flow: loadFlow, predict: loadPredictions}[sub])();
}

async function updateHeaderQuote() {
  try {
    const b = await api("/board");
    if (!b.ok && !b.futures) return;
    const q = (b.futures || []).find(x => x.symbol === state.symbol);
    if (q && q.ok) {
      $("#hdr-quote").innerHTML = `<span class="px">${fmt(q.last, 4)}</span>
        <span class="${cls(q.change)}">${sign(q.change_pct)}${fmt(q.change_pct, 2)}%</span>`;
      // convenience: pre-fill sizer entry if empty
      const e = $("#sz-entry");
      if (e && !e.value) { e.placeholder = fmt(q.last, 4); }
    }
  } catch (e) { /* header quote is best-effort */ }
}

/* ---------- event countdown ---------- */
function etDate(dateStr, timeStr) {
  const m = (timeStr || "").match(/(\d{1,2}):(\d{2})/);
  const hh = m ? m[1].padStart(2, "0") : "23", mm = m ? m[2] : "59";
  const probe = new Date(`${dateStr}T12:00:00Z`);
  let off = "-05:00";
  try {
    const tz = new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", timeZoneName: "shortOffset"})
      .formatToParts(probe).find(p => p.type === "timeZoneName").value;   // e.g. GMT-4
    const n = parseInt(tz.replace("GMT", ""), 10) || -5;
    off = (n < 0 ? "-" : "+") + String(Math.abs(n)).padStart(2, "0") + ":00";
  } catch (e) { /* fallback EST */ }
  return new Date(`${dateStr}T${hh}:${mm}:00${off}`);
}

async function initCountdown() {
  try {
    const cal = await api("/calendar?days=14&country=USD");
    if (!cal.ok) return;
    const now = Date.now();
    state.nextEvent = (cal.events || [])
      .filter(e => ["extreme", "high"].includes(e.impact))
      .map(e => ({...e, when: etDate(e.date, e.time)}))
      .filter(e => e.when.getTime() > now)
      .sort((a, b) => a.when - b.when)[0] || null;
  } catch (e) { /* countdown is best-effort */ }
}

function renderCountdown() {
  const el = $("#event-countdown");
  const ev = state.nextEvent;
  if (!ev) { el.textContent = ""; return; }
  let ms = ev.when.getTime() - Date.now();
  if (ms < -30 * 60000) { initCountdown(); return; }
  if (ms < 0) { el.textContent = `⚡ ${ev.event} — LIVE NOW`; el.classList.add("imminent"); return; }
  const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000),
        m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
  const t = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  el.textContent = `⏳ ${ev.event} in ${t}`;
  el.classList.toggle("imminent", ms < 30 * 60000 && ev.impact === "extreme" || ms < 10 * 60000);
}

/* ---------- game plan ---------- */
function zoneCard(z) {
  const range = z.lo === z.hi ? fmt(z.mid, 4) : `${fmt(z.lo, 4)} – ${fmt(z.hi, 4)}`;
  const gcls = z.grade === "A+" ? "Ap" : z.grade;
  return `<div class="zone-card ${z.side}">
    <div class="zr"><span class="zp">${range}</span>
      <span class="grade ${gcls}">${z.grade} confluence</span>
      <span class="impact-chips">${z.labels.slice(0, 4).map(l => `<span>${esc(l)}</span>`).join("")}</span></div>
    <div class="act">${esc(z.action)}</div></div>`;
}

async function loadBriefing() {
  const el = $("#tab-briefing");
  el.innerHTML = `<div class="loading">Building the game plan for ${state.symbol}… (cross-referencing profile, composite, flow, calendar — first run takes ~15s)</div>`;
  try {
    const d = await api(`/gameplan/${state.symbol}`);
    if (!d.ok) { el.innerHTML = errBox(d.error || "game plan unavailable", "Free data source may be briefly rate-limited — try again in ~30s."); return; }
    const q = d.quote || {};
    const g = d.gamma || {};
    const ev = d.next_major_event;
    const chips = `
      <div class="chip-row">
        <div class="chip"><span class="lbl">${esc(d.symbol)}</span> ${fmt(d.last, 2)}
          <span class="${cls(q.change_pct)}">${sign(q.change_pct)}${fmt(q.change_pct, 2)}%</span></div>
        ${g.ok ? `<div class="chip"><span class="lbl">Gamma</span> <span class="${g.regime === "positive" ? "up" : "down"}">${esc(g.regime)}</span></div>` : ""}
        ${ev ? `<div class="chip"><span class="lbl">Next event</span> ${esc(ev.event)} · ${ev.days_until === 0 ? "TODAY " + esc(ev.time) : ev.days_until + "d"}</div>` : ""}
        <div class="chip"><span class="lbl">Plan time</span> ${esc(d.generated.slice(11, 16))} ET</div>
      </div>`;
    const warn = (d.warnings || []).map(w =>
      `<div class="brief-warning ${/CRITICAL|extreme/i.test(w) ? "crit" : ""}">${esc(w)}</div>`).join("");
    const above = (d.zones_above || []).slice().reverse();   // farthest first for ladder
    const ladder = `
      <div class="ladder">
        ${above.map(zoneCard).join("") || `<p class="muted small">No mapped zones above.</p>`}
        <div class="price-divider"><span class="line"></span><span class="px">${fmt(d.last, 2)}</span><span class="line"></span></div>
        ${(d.zones_below || []).map(zoneCard).join("") || `<p class="muted small">No mapped zones below.</p>`}
      </div>`;
    const ideas = (d.ideas || []).map(i => `
      <div class="idea-card"><div class="h">${esc(i.what)} <span class="grade ${i.grade === "A+" ? "Ap" : i.grade}">${i.grade}</span>
        <span class="num muted">${esc(i.zone)}</span></div>
        <p><span class="k">If it rejects:</span> ${esc(i.plan_fade)}</p>
        <p><span class="k">If it accepts:</span> ${esc(i.plan_break)}</p></div>`).join("");
    const setups = (d.suggested_setups || []).map(s =>
      `<li><b>${esc(s.id)}</b> — ${esc(s.reason)} <button class="link goto-pb">playbook</button></li>`).join("");
    el.innerHTML = `
      ${chips}
      ${warn ? `<div class="panel">${warn}</div>` : ""}
      <div class="grid2">
        <div class="panel"><div class="panel-title">📖 The Story <small>what the market has been doing, in order</small></div>
          <ol class="story-list">${(d.story || []).map(s => `<li>${esc(s)}</li>`).join("")}</ol>
          ${!d.composite_ok ? `<p class="mt8 muted small">Multi-day composite unavailable: ${esc(d.composite_error || "")}</p>` : ""}</div>
        <div class="panel"><div class="panel-title">🗺 Trade Map <small>every module's levels, clustered &amp; graded — trade zone to zone</small></div>
          ${ladder}</div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">⚔ Today's Trade Ideas <small>if/then plans at the nearest strong zones</small></div>
          ${ideas || `<p class="muted small">No graded zones near price — wait for the market to come to a mapped area.</p>`}
          ${setups ? `<div class="mt12"><b>Context-matched setups</b><ul class="clean small">${setups}</ul></div>` : ""}</div>
        <div class="panel"><div class="panel-title">✅ Today's Do / Don't</div>
          <div class="dd-grid">
            <div><b class="up">Do</b><ul class="clean small">${(d.do || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
            <div class="dont"><b class="down">Don't</b><ul class="clean small">${(d.dont || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
          </div>
          <div class="mt12"><b>Pre-open checklist</b><ul class="clean small">${(d.checklist || []).map(c => `<li>${esc(c)}</li>`).join("")}</ul></div></div>
      </div>`;
    $$(".goto-pb", el).forEach(btn => btn.onclick = () => $(`#tabs button[data-tab="playbooks"]`).click());
  } catch (e) { el.innerHTML = errBox("Game plan failed: " + e.message, "Refresh in a moment — free data sources occasionally throttle."); }
}

/* ---------- board / live desk ---------- */
async function loadBoard() {
  renderChart();
  loadRelVol();
  initSizer();
  loadOrderFlow();
  loadRithmic();
  updateChartLines();
  try {
    const b = await api("/board");
    if (!b.futures) { $("#board-grid").innerHTML = errBox(b.error || "board unavailable"); return; }
    const card = q => `
      <div class="qcard ${q.symbol === state.symbol ? "selected" : ""}" data-sym="${esc(q.symbol)}" title="Click to focus">
        <div class="sym"><b>${esc(q.symbol)}</b><span>${esc(q.name)}</span></div>
        <div class="px">${q.ok ? fmt(q.last, 4) : "—"}</div>
        <div class="chg ${cls(q.change)}">${q.ok ? `${sign(q.change)}${fmt(q.change, 4)} (${sign(q.change_pct)}${fmt(q.change_pct, 2)}%)` : "no data"}</div>
      </div>`;
    $("#board-grid").innerHTML = b.futures.map(card).join("") +
      `<div class="section-break">Context tape</div>` + b.context.map(card).join("");
    $$("#board-grid .qcard").forEach(c => c.onclick = () => {
      const s = c.dataset.sym;
      if (SYMBOLS.includes(s)) { $("#symbol-select").value = s; $("#symbol-select").onchange(); }
    });
  } catch (e) { $("#board-grid").innerHTML = errBox(e.message); }
}

async function renderChart() {
  $("#chart-symbol").textContent = state.symbol;
  $$("#chart-intervals button").forEach(b => {
    b.onclick = () => {
      $$("#chart-intervals button").forEach(x => x.classList.toggle("active", x === b));
      state.interval = b.dataset.i; state.period = b.dataset.p;
      renderChart();
    };
  });
  const el = $("#chart");
  if (typeof LightweightCharts === "undefined") { el.innerHTML = errBox("chart library failed to load"); return; }
  if (!state.chart) {
    state.chart = LightweightCharts.createChart(el, {
      layout: {background: {color: "transparent"}, textColor: "#8298ae"},
      grid: {vertLines: {color: "#16202f"}, horzLines: {color: "#16202f"}},
      timeScale: {timeVisible: true, secondsVisible: false},
      rightPriceScale: {borderColor: "#1f2c3f"},
    });
    state.series = state.chart.addCandlestickSeries({
      upColor: "#34d399", downColor: "#fb5d6c", wickUpColor: "#34d399", wickDownColor: "#fb5d6c", borderVisible: false,
    });
    new ResizeObserver(() => state.chart.applyOptions({width: el.clientWidth})).observe(el);
    initChartTrading(el);
  }
  try {
    const d = await api(`/candles/${state.symbol}?period=${state.period}&interval=${state.interval}`);
    if (!d.ok) throw new Error(d.error);
    state.series.setData(d.candles);
    state.chart.timeScale().fitContent();
    loadPatterns();
  } catch (e) { console.warn("chart", e); }
}

/* ---------- chart click-to-trade (simulated account) ---------- */
function initChartTrading(container) {
  container.style.position = "relative";
  const pop = document.createElement("div");
  pop.className = "chart-popup";
  pop.style.display = "none";
  container.appendChild(pop);
  state.chartPopup = pop;
  state.chart.subscribeClick(param => {
    if (!param.point || !state.series) { pop.style.display = "none"; return; }
    const raw = state.series.coordinateToPrice(param.point.y);
    if (raw == null) return;
    const tick = (TICKS[state.symbol] || [0.25])[0];
    const px = Math.round(raw / tick) * tick;
    const dp = tick < 0.01 ? 5 : tick < 1 ? 2 : 0;
    pop.innerHTML = `<b class="num">${fmt(px, dp)}</b>
      <button class="btn-buy" data-s="buy">Buy</button>
      <button class="btn-sell" data-s="sell">Sell</button>
      <button class="t-x">✕</button>
      <div class="muted" style="font-size:10px">simulated account · bracket from Trade tab settings</div>`;
    pop.style.left = Math.min(param.point.x + 12, container.clientWidth - 190) + "px";
    pop.style.top = Math.max(param.point.y - 14, 4) + "px";
    pop.style.display = "block";
    pop.querySelector(".t-x").onclick = () => pop.style.display = "none";
    pop.querySelectorAll("[data-s]").forEach(b => b.onclick = async () => {
      pop.style.display = "none";
      await placeChartOrder(b.dataset.s, px);
    });
  });
}

async function placeChartOrder(side, price) {
  try {
    const d = await api(`/dom/${state.symbol}`);
    if (!d.ok) { showToast({kind: "headline", id: "co" + Date.now(), text: "Order rejected: " + (d.error || "no market data")}); return; }
    const tick = d.tick;
    let otype = "limit";
    if (side === "buy" && price > d.last) otype = "stop";
    if (side === "sell" && price < d.last) otype = "stop";
    const slT = parseInt(($("#dom-sl") || {}).value, 10) || 16;
    const tpT = parseInt(($("#dom-tp") || {}).value, 10) || 32;
    const dir = side === "buy" ? 1 : -1;
    const body = {symbol: state.symbol, side, qty: parseInt(($("#dom-qty") || {}).value, 10) || 1,
                  otype, price, stop_loss: price - dir * slT * tick, take_profit: price + dir * tpT * tick};
    const r = await fetch("/api/paper/order", {method: "POST",
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    const j = await r.json();
    showToast({kind: j.ok ? "prediction" : "headline", id: "co" + Date.now(),
               text: j.ok ? `Sim ${otype} ${side} placed at ${fmt(price, 2)} (bracket ${slT}/${tpT} ticks). Track it on the Trade tab.`
                          : "Order rejected: " + (j.error || "")});
    updateChartLines();
  } catch (e) { /* best effort */ }
}

async function updateChartLines() {
  if (!state.series || state.tab !== "board") return;
  try {
    const d = await api(`/dom/${state.symbol}`);
    if (!d.ok) return;
    (state.chartLines || []).forEach(l => { try { state.series.removePriceLine(l); } catch (e) {} });
    state.chartLines = [];
    const a = d.account || {};
    if (a.position && a.avg_price) {
      state.chartLines.push(state.series.createPriceLine({
        price: a.avg_price, color: "#ffd60a", lineWidth: 2, lineStyle: 0,
        title: `POS ${a.position > 0 ? "+" : ""}${a.position}`}));
    }
    (a.open_orders || []).forEach(o => {
      state.chartLines.push(state.series.createPriceLine({
        price: o.price, color: o.otype === "stop" ? "#ff453a" : "#0a84ff",
        lineWidth: 1, lineStyle: 2,
        title: `${o.side.toUpperCase()} ${o.qty} ${o.otype}`}));
    });
  } catch (e) { /* best effort */ }
}

async function loadPatterns() {
  const box = $("#structure-read");
  try {
    const p = await api(`/patterns/${state.symbol}`);
    if (!p.ok) {
      if (box) box.innerHTML = "";
      if (state.series) state.series.setMarkers([]);
      return;
    }
    // markers are built on 5m pivots - only pin them when the chart shows 5m bars
    if (state.series) state.series.setMarkers(state.interval === "5m" ? (p.markers || []) : []);
    if (box) box.innerHTML = `
      <div class="panel-title" style="margin-top:14px">Structure Read — <span class="accent">${esc(p.structure)}</span>
        <button class="info" data-info="${esc(p.how_to_read)}">i</button>
        <small>swing pivots, coils, double tops/bottoms, breakout proximity — auto-detected</small></div>
      <ul class="clean small">${(p.reads || []).map(r => `<li>${esc(r)}</li>`).join("")}</ul>`;
  } catch (e) { if (box) box.innerHTML = ""; }
}

async function loadRelVol() {
  const cv = $("#relvol-canvas");
  const {ctx, W} = hiDPI(cv);
  try {
    const d = await api(`/relative-volume/${state.symbol}`);
    if (!d.ok) throw new Error(d.error);
    const n = d.slots.length, w = W / n, max = Math.max(...d.avg, ...d.today, 1);
    d.slots.forEach((s, i) => {
      const ha = d.avg[i] / max * 115, ht = d.today[i] / max * 115;
      ctx.fillStyle = "#2c4258"; ctx.fillRect(i * w + 1, 128 - ha, w * 0.44, ha);
      ctx.fillStyle = d.today[i] > d.avg[i] ? "#34d399" : "#56708c";
      ctx.fillRect(i * w + w * 0.5, 128 - ht, w * 0.44, ht);
      if (i % Math.ceil(n / 14) === 0) { ctx.fillStyle = "#56708c"; ctx.font = "10px JetBrains Mono"; ctx.fillText(s, i * w, 144); }
    });
  } catch (e) {
    ctx.fillStyle = "#8298ae"; ctx.font = "12px JetBrains Mono";
    ctx.fillText("relative volume unavailable: " + e.message, 10, 60);
  }
}

/* ---------- order flow pulse ---------- */
async function loadOrderFlow() {
  const panel = $("#of-panel");
  if (!panel) return;
  const body = () => panel.querySelector(".of-body") ||
    panel.appendChild(Object.assign(document.createElement("div"), {className: "of-body"}));
  panel.querySelectorAll(".muted.small, .of-body").forEach(n => n.remove());
  const el = body();
  try {
    const d = await api(`/orderflow/${state.symbol}`);
    if (!d.ok) throw new Error(d.error);
    const spikes = (d.spikes || []).slice(-4).reverse().map(s =>
      `<li><span class="${s.side === "buy" ? "up" : "down"}">${s.side}</span> burst ${s.mult}× at <span class="num">${fmt(s.price, 4)}</span>
       <span class="muted">${new Date(s.time * 1000).toLocaleTimeString("en-US", {timeZone: "America/New_York", hour: "2-digit", minute: "2-digit"})}</span></li>`).join("");
    el.innerHTML = `
      <canvas id="of-canvas" height="84"></canvas>
      <div class="small mt8">Δ30m: <b class="num ${cls(d.delta_last30)}">${sign(d.delta_last30)}${fmt(d.delta_last30, 0)}</b>
        · px: <b class="num ${cls(d.price_last30)}">${sign(d.price_last30)}${fmt(d.price_last30, 2)}</b>
        · tape <b class="num">${fmt(d.tape_speed, 2)}×</b></div>
      <ul class="clean small mt8">${(d.signals || []).map(s => `<li>${esc(s)}</li>`).join("")}</ul>
      ${spikes ? `<div class="mt8 small"><b>Recent volume bursts</b><ul class="clean small">${spikes}</ul></div>` : ""}
      <div class="muted small mt8">${esc(d.note)}</div>`;
    drawDelta(d.cum_delta);
  } catch (e) {
    el.innerHTML = `<div class="muted small">Order flow pulse unavailable: ${esc(e.message)}</div>`;
  }
}

function drawDelta(series) {
  const cv = $("#of-canvas"); if (!cv || !series || series.length < 2) return;
  const {ctx, W, H} = hiDPI(cv);
  const pad = 4;
  const vals = series.map(p => p.value);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = (max - min) || 1;
  const x = i => pad + i / (series.length - 1) * (W - 2 * pad);
  const y = v => H - pad - (v - min) / span * (H - 2 * pad);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#2a3a4d"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - pad, y(0)); ctx.stroke();
  ctx.setLineDash([]);
  const up = vals[vals.length - 1] >= 0;
  ctx.strokeStyle = up ? "#34d399" : "#fb5d6c"; ctx.lineWidth = 1.6;
  ctx.beginPath();
  series.forEach((p, i) => i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value)));
  ctx.stroke();
  ctx.fillStyle = "#56708c"; ctx.font = "9.5px JetBrains Mono";
  ctx.fillText("cumulative delta (session)", pad + 2, 11);
}

/* ---------- prediction markets ---------- */
async function loadPredictions() {
  const el = $("#macro-body");
  el.innerHTML = `<div class="loading">Reading prediction markets…</div>`;
  try {
    const d = await api("/predictions");
    if (!d.ok && !(d.markets || []).length) {
      el.innerHTML = errBox(d.error || (d.errors || []).map(x => `${x.source}: ${x.error}`).join(" · ") || "prediction markets unreachable");
      return;
    }
    const swingRow = m => `
      <div class="alert-item" style="border-color:${m.change_24h > 0 ? "var(--green)" : "var(--red)"}">
        <span class="badge ${Math.abs(m.change_24h) >= 15 ? "critical" : "high"}">${sign(m.change_24h)}${fmt(m.change_24h, 1)} pts/24h</span>
        <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.question)}</a>
        <div class="news-meta mt8">${esc(m.source)} · now <b>${fmt(m.prob, 1)}%</b> · $${fmt(m.volume_24h, 0)} 24h vol
        <span class="impact-chips">${m.impacts.map(i => `<span>${esc(i)}</span>`).join("")}</span></div></div>`;
    const rows = (d.markets || []).map(m => `
      <tr><td><a href="${esc(m.url)}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none">${esc(m.question)}</a>
        <div class="muted small">${esc(m.source)} · ${esc(m.outcome)} · ends ${esc(m.ends)}</div></td>
      <td class="num"><b>${fmt(m.prob, 1)}%</b></td>
      <td class="num ${cls(m.change_24h)}">${sign(m.change_24h)}${fmt(m.change_24h, 1)}</td>
      <td class="num">$${fmt(m.volume_24h, 0)}</td>
      <td class="impact-chips">${m.impacts.map(i => `<span>${esc(i)}</span>`).join("")}</td></tr>`).join("");
    el.innerHTML = `
      <div class="grid2">
        <div class="panel"><div class="panel-title">⚡ Repricing Alerts <small>≥8 pts moved in 24h — positioning is shifting</small></div>
          ${(d.swing_alerts || []).map(swingRow).join("") || `<p class="muted small">No major repricings in the last 24h.</p>`}
          <div class="mt12"><b>Prediction-market playbook</b>
            <ul class="clean small">${(d.playbook || []).map(p => `<li>${esc(p)}</li>`).join("")}</ul></div></div>
        <div class="panel"><div class="panel-title">Macro Markets Board <small>Polymarket + Kalshi · sorted by 24h volume · chips = futures affected</small></div>
          <div style="max-height:680px;overflow-y:auto">
          <table><tr><th>Market</th><th>Prob</th><th>Δ24h</th><th>Vol 24h</th><th>Hits</th></tr>${rows}</table></div>
          ${(d.errors || []).length ? `<p class="mt8 muted small">Sources unreachable: ${d.errors.map(x => esc(x.source)).join(", ")}</p>` : ""}</div>
      </div>`;
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- position sizer ---------- */
function initSizer() {
  const ids = ["sz-acct", "sz-risk", "sz-entry", "sz-stop"];
  const saved = JSON.parse(localStorage.getItem("edgedesk.sizer") || "{}");
  if (saved.acct) $("#sz-acct").value = saved.acct;
  if (saved.risk) $("#sz-risk").value = saved.risk;
  ids.forEach(id => $("#" + id).oninput = computeSizer);
  computeSizer();
}

function computeSizer() {
  const acct = parseFloat($("#sz-acct").value), riskPct = parseFloat($("#sz-risk").value),
        entry = parseFloat($("#sz-entry").value), stop = parseFloat($("#sz-stop").value);
  localStorage.setItem("edgedesk.sizer", JSON.stringify({acct: $("#sz-acct").value, risk: $("#sz-risk").value}));
  const out = $("#sz-out");
  if (!acct || !riskPct || isNaN(entry) || isNaN(stop) || entry === stop) {
    out.innerHTML = `<span class="muted small">Enter entry &amp; stop to size the trade. Tick data for <b>${esc(state.symbol)}</b>: ${TICKS[state.symbol][0]} / $${TICKS[state.symbol][1]}.</span>`;
    return;
  }
  const [tick, tickVal] = TICKS[state.symbol];
  const dir = stop < entry ? "LONG" : "SHORT";
  const stopTicks = Math.abs(entry - stop) / tick;
  const riskPerCt = stopTicks * tickVal;
  const budget = acct * riskPct / 100;
  const contracts = Math.floor(budget / riskPerCt);
  const dist = Math.abs(entry - stop);
  const tgt = r => dir === "LONG" ? entry + dist * r : entry - dist * r;
  out.innerHTML = contracts < 1
    ? `<span class="down">Stop too wide: 1 contract risks $${fmt(riskPerCt)} &gt; budget $${fmt(budget)}.<br>
       Tighten structure or skip — never widen risk to fit a trade.</span>`
    : `<div class="big">${contracts} contract${contracts > 1 ? "s" : ""} ${dir}</div>
       <table class="small">
       <tr><td class="muted">Stop distance</td><td class="num">${fmt(stopTicks, 0)} ticks ($${fmt(riskPerCt)}/ct)</td></tr>
       <tr><td class="muted">Total risk</td><td class="num">$${fmt(contracts * riskPerCt)} of $${fmt(budget)} budget</td></tr>
       <tr><td class="muted">+1R target</td><td class="num">${fmt(tgt(1), 4)}</td></tr>
       <tr><td class="muted">+2R target</td><td class="num up">${fmt(tgt(2), 4)}</td></tr>
       <tr><td class="muted">+3R target</td><td class="num up">${fmt(tgt(3), 4)}</td></tr></table>
       <div class="muted small mt8">Only take it if the realistic target beats the stop distance — asymmetry or pass.</div>`;
}

/* ---------- profile workbench ---------- */
function wbState() {
  if (!state.wb) state.wb = { days: 10, session: "rth", mode: "tpo", va: 70,
    show: {trail: true, vaBand: true, ib: true, oc: true, singles: true, naked: true, vwap: true},
    typeFilter: "", data: null, view: null, tpr: 0 };
  return state.wb;
}

async function loadProfile() {
  const el = $("#tab-profile");
  const wb = wbState();
  el.innerHTML = `
    <div class="panel">
      <div class="panel-title">🔬 Market Profile Workbench — <span class="accent">${esc(state.symbol)}</span>
        <button class="info" data-info="The classic TPO chart: each column is one trading session on a single shared price scale, each letter block is one 30-minute period (A = first period, B = second…). Wide rows = prices the market ACCEPTED (it kept coming back); short rows = rejection. The bright-blue row is the POC (most-traded price), the shaded band the value area, the purple bracket the first hour. The purple column at the right merges every visible session into one composite. Scroll to zoom the price axis, drag to pan, double-click to reset.">i</button>
        <small>scroll = zoom · drag = pan · double-click = reset · click a column for letters drill-down</small></div>
      <div class="wb-controls">
        <span class="wb-group"><span class="wb-lbl">Days</span><span class="seg" id="wb-days">
          ${[5, 10, 15, 20].map(d => `<button data-v="${d}" ${wb.days === d ? 'class="active"' : ""}>${d}</button>`).join("")}</span></span>
        <span class="wb-group"><span class="wb-lbl">Session</span><span class="seg" id="wb-session">
          <button data-v="rth" ${wb.session === "rth" ? 'class="active"' : ""}>RTH</button>
          <button data-v="eth" ${wb.session === "eth" ? 'class="active"' : ""}>Globex</button>
          <button data-v="all" ${wb.session === "all" ? 'class="active"' : ""}>24h</button></span></span>
        <span class="wb-group"><span class="wb-lbl">Value</span><span class="seg" id="wb-va">
          ${[68, 70, 80].map(v => `<button data-v="${v}" ${wb.va === v ? 'class="active"' : ""}>${v}%</button>`).join("")}</span></span>
        <span class="wb-group"><span class="wb-lbl">Ticks/row</span><select id="wb-tpr">
          ${[[0, "Auto"], [1, "1"], [2, "2"], [4, "4"], [5, "5"], [8, "8"], [10, "10"], [16, "16"], [20, "20"], [25, "25"], [50, "50"]]
            .map(([v, l]) => `<option value="${v}" ${wb.tpr === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <button class="info" data-info="How many ticks of price each TPO row represents — the vertical resolution of the profile. Fewer ticks per row = finer letter prints (more rows, more detail); more ticks = a compressed, structural view. Real platforms default ES to 4–6 ticks per row for a clean RTH letter profile. Auto picks a size that fits the whole range on screen.">i</button></span>
        <span class="wb-group"><span class="wb-lbl">Overlays</span><span class="seg" id="wb-show">
          ${[["trail", "POC trail"], ["vaBand", "VA band"], ["ib", "IB"], ["oc", "O/C"], ["singles", "Singles"], ["naked", "Naked POC"], ["vwap", "VWAP"]]
            .map(([k, l]) => `<button data-v="${k}" ${wb.show[k] ? 'class="active"' : ""}>${l}</button>`).join("")}</span></span>
        <span class="wb-group"><span class="wb-lbl">Day type</span><span class="seg" id="wb-type">
          <button data-v="" ${!wb.typeFilter ? 'class="active"' : ""}>all</button>
          ${["trend", "normal", "neutral", "balanced", "P-shape", "b-shape"].map(t =>
            `<button data-v="${t}" ${wb.typeFilter === t ? 'class="active"' : ""}>${t}</button>`).join("")}</span></span>
      </div>
      <div id="wb-canvas-wrap" style="position:relative">
        <canvas id="wb-canvas" height="600"></canvas>
        <div id="wb-tip" class="wb-tip"></div>
        <div id="wb-status" class="loading">Building ${wb.days} ${wb.session.toUpperCase()} sessions…</div>
      </div>
      <div class="legend small muted" id="wb-legend"></div>
    </div>
    <div id="wb-stats"></div>
    <div id="wb-drill"></div>
    <div id="wb-context"></div>`;
  wireWorkbenchControls();
  fetchWorkbench();
  loadProfileContext();
}

function wireWorkbenchControls() {
  const wb = wbState();
  const wire = (id, fn, multi = false) => $$(`#${id} button`).forEach(b => b.onclick = () => {
    if (!multi) $$(`#${id} button`).forEach(x => x.classList.toggle("active", x === b));
    else b.classList.toggle("active");
    fn(b);
  });
  wire("wb-days", b => { wb.days = parseInt(b.dataset.v, 10); fetchWorkbench(); });
  wire("wb-session", b => { wb.session = b.dataset.v; fetchWorkbench(); });
  wire("wb-va", b => { wb.va = parseInt(b.dataset.v, 10); fetchWorkbench(); });
  const tpr = $("#wb-tpr");
  if (tpr) tpr.onchange = () => { wb.tpr = parseInt(tpr.value, 10); wb.view = null; fetchWorkbench(); };
  wire("wb-show", b => { wb.show[b.dataset.v] = !wb.show[b.dataset.v]; drawWorkbench(); }, true);
  wire("wb-type", b => { wb.typeFilter = b.dataset.v; drawWorkbench(); renderWbStats(); });
}

async function fetchWorkbench() {
  const wb = wbState();
  const st = $("#wb-status");
  if (st) { st.style.display = ""; st.textContent = `Building ${wb.days} ${wb.session.toUpperCase()} sessions…`; }
  try {
    const d = await api(`/profile-advanced/${state.symbol}?days=${wb.days}&session=${wb.session}&va=${wb.va}&tpr=${wb.tpr || 0}`);
    if (!d.ok) throw new Error(d.error || "workbench unavailable");
    wb.data = d;
    if (st) st.style.display = "none";
    drawWorkbench();
    renderWbStats();
    const lg = $("#wb-legend");
    if (lg) lg.innerHTML = `<b class="num">${d.ticks_per_row} tick${d.ticks_per_row > 1 ? "s" : ""}/row (${fmt(d.step, 4)} pts)</b>
      · <span style="color:#00b2ff">■</span> POC row · shaded = value area · <span style="color:#bf5af2">|</span> Initial Balance
      · <span style="color:#30d158">▶</span> open <span style="color:#fff">◀</span> close · <span style="color:#64d2ff">◆</span> VWAP
      · <span style="color:#ffd60a">- - -</span> naked POC ray · ${esc(d.legend.naked)}`;
  } catch (e) {
    if (st) { st.style.display = ""; st.innerHTML = errBox("Workbench failed: " + e.message, "Needs intraday history — retry if the free feed is rate-limited."); }
  }
}

function wbVisibleSessions() {
  const wb = wbState();
  if (!wb.data) return [];
  return wb.data.sessions.filter(s => !wb.typeFilter || s.day_type === wb.typeFilter);
}

const WB_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function periodColor(p, total) {
  const hue = 350 - (p / Math.max(total - 1, 1)) * 215;   // A=red/pink -> mid=blue -> last=green
  return `hsl(${hue}, 62%, 56%)`;
}

function cellPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawWorkbench() {
  const wb = wbState();
  const cv = $("#wb-canvas");
  if (!cv || !wb.data) return;
  const d = wb.data;
  const sessions = wbVisibleSessions();
  const {ctx, W, H} = hiDPI(cv);
  if (!sessions.length) {
    ctx.fillStyle = "#6e6e76"; ctx.font = "13px JetBrains Mono";
    ctx.fillText("no sessions match the day-type filter", 20, 50);
    return;
  }
  const grid = d.grid, n = grid.length, step = d.step;
  const fullLo = grid[0], fullHi = grid[n - 1];
  if (!wb.view) wb.view = [fullLo, fullHi];
  const [vLo, vHi] = wb.view;
  const padL = 74, padR = 8, padT = 14, padB = 46;
  const nCols = sessions.length + 1;                       // +1 composite
  const colW = (W - padL - padR) / nCols;
  const plotH = H - padT - padB;
  const yOf = p => padT + (1 - (p - vLo) / (vHi - vLo)) * plotH;
  const rowH = Math.max(1, plotH / ((vHi - vLo) / step));
  const inView = i => grid[i] >= vLo - step && grid[i] <= vHi + step;

  // price axis + gridlines
  ctx.font = "10px JetBrains Mono"; ctx.fillStyle = "#6e6e76";
  const nLabels = 14;
  for (let i = 0; i <= nLabels; i++) {
    const p = vLo + (vHi - vLo) * i / nLabels;
    const y = yOf(p);
    ctx.strokeStyle = "#1d1d22"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(fmt(p, 2), 4, y + 3);
  }
  // last price line
  if (d.last >= vLo && d.last <= vHi) {
    ctx.strokeStyle = "#0a84ff"; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(padL, yOf(d.last)); ctx.lineTo(W - padR, yOf(d.last)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#0a84ff"; ctx.fillText(fmt(d.last, 2), W - padR - 56, yOf(d.last) - 4);
  }

  const pocTrail = [], vwapTrail = [];

  sessions.forEach((s, si) => {
    const x0 = padL + si * colW + 4;
    const usable = colW - 12;
    const periods = s.period_ranges || [];
    const nP = Math.max(periods.length, 1);

    // value-area band
    if (wb.show.vaBand) {
      ctx.fillStyle = "rgba(100,210,255,.07)";
      const yTop = Math.max(padT, yOf(grid[s.vah_i]) - rowH / 2);
      const yBot = Math.min(H - padB, yOf(grid[s.val_i]) + rowH / 2);
      if (yBot > yTop) ctx.fillRect(x0 - 3, yTop, colW - 7, yBot - yTop);
    }

    // TPO letter prints
    const cellH = Math.max(2, Math.min(rowH - 0.8, 18));
    const cellW = Math.max(3, Math.min(cellH * 0.95, usable / Math.min(nP, 13)));
    const maxFit = Math.max(1, Math.floor(usable / cellW));
    const fontPx = Math.min(cellH - 4, 11);
    for (let i = s.lo_i; i <= s.hi_i; i++) {
      if (!inView(i) || !s.tpo[i]) continue;
      const yC = yOf(grid[i]);
      if (yC < padT - rowH || yC > H - padB + rowH) continue;
      let x = x0, drawn = 0, overflow = false;
      for (let p = 0; p < nP; p++) {
        const [a, b] = periods[p];
        if (i < a || i > b) continue;
        if (drawn >= maxFit) { overflow = true; break; }
        ctx.fillStyle = i === s.poc_i ? "#00b2ff" : periodColor(p, nP);
        cellPath(ctx, x, yC - cellH / 2, cellW - 1.2, cellH, Math.min(3.5, cellH / 3));
        ctx.fill();
        if (cellH >= 8.5) {
          ctx.fillStyle = "rgba(255,255,255,.95)";
          ctx.font = `600 ${fontPx}px JetBrains Mono`;
          ctx.fillText(WB_LETTERS[p] || "+", x + (cellW - 1.2) / 2 - fontPx * 0.3, yC + fontPx * 0.36);
        }
        x += cellW; drawn++;
      }
      if (overflow && cellH >= 8.5) { ctx.fillStyle = "#9a9aa2"; ctx.fillText("›", x + 1, yC + 3); }
    }

    // singles markers
    if (wb.show.singles) {
      ctx.fillStyle = "#bf5af2";
      s.singles_i.forEach(i => {
        if (inView(i)) ctx.fillRect(x0 - 3, yOf(grid[i]) - 1, 2, 2);
      });
    }

    // VAH / POC / VAL guides
    ctx.font = "9px JetBrains Mono";
    [["VAH", s.vah_i, "#64d2ff"], ["POC", s.poc_i, "#00b2ff"], ["VAL", s.val_i, "#64d2ff"]].forEach(([lbl, idx, col]) => {
      const y = yOf(grid[idx]);
      if (y < padT || y > H - padB) return;
      ctx.strokeStyle = col; ctx.beginPath();
      ctx.moveTo(x0 - 7, y); ctx.lineTo(x0 - 2, y); ctx.stroke();
      if (colW > 130) { ctx.fillStyle = col; ctx.fillText(lbl, x0 - 7, y - 3); }
    });

    // IB bracket
    if (wb.show.ib) {
      ctx.strokeStyle = "#bf5af2"; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0 - 3, Math.max(padT, yOf(s.ib_hi))); ctx.lineTo(x0 - 3, Math.min(H - padB, yOf(s.ib_lo))); ctx.stroke();
      ctx.lineWidth = 1;
    }
    // open / close markers
    if (wb.show.oc) {
      if (s.open >= vLo && s.open <= vHi) {
        ctx.fillStyle = "#30d158";
        ctx.beginPath(); ctx.moveTo(x0 - 2, yOf(s.open)); ctx.lineTo(x0 + 4, yOf(s.open) - 3.5); ctx.lineTo(x0 + 4, yOf(s.open) + 3.5); ctx.fill();
      }
      if (s.close >= vLo && s.close <= vHi) {
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.moveTo(x0 + usable + 4, yOf(s.close)); ctx.lineTo(x0 + usable - 2, yOf(s.close) - 3.5); ctx.lineTo(x0 + usable - 2, yOf(s.close) + 3.5); ctx.fill();
      }
    }
    // VWAP marker
    if (wb.show.vwap && s.vwap && s.vwap >= vLo && s.vwap <= vHi) {
      const vx = x0 + usable / 2, vy = yOf(s.vwap);
      ctx.fillStyle = "#64d2ff";
      ctx.beginPath(); ctx.moveTo(vx, vy - 4); ctx.lineTo(vx + 4, vy); ctx.lineTo(vx, vy + 4); ctx.lineTo(vx - 4, vy); ctx.fill();
      vwapTrail.push([vx, vy]);
    }
    // poor extremes flags
    ctx.fillStyle = "#ff453a"; ctx.font = "10px JetBrains Mono";
    if (s.poor_high && s.high <= vHi) ctx.fillText("⚑", x0 + usable / 2, yOf(s.high) - 4);
    if (s.poor_low && s.low >= vLo) ctx.fillText("⚑", x0 + usable / 2, yOf(s.low) + 11);
    // naked POC ray
    if (wb.show.naked && s.naked && s.poc_price >= vLo && s.poc_price <= vHi) {
      ctx.strokeStyle = "#ffd60a"; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x0, yOf(s.poc_price)); ctx.lineTo(W - padR, yOf(s.poc_price)); ctx.stroke();
      ctx.setLineDash([]);
    }
    pocTrail.push([x0 + usable / 2, yOf(grid[s.poc_i])]);
    // labels
    ctx.fillStyle = "#6e6e76"; ctx.font = "9.5px JetBrains Mono";
    ctx.fillText(s.day.slice(5), x0, H - padB + 14);
    ctx.fillStyle = s.day_type === "trend" ? "#30d158" : s.day_type.includes("shape") ? "#ffd60a" : "#6e6e76";
    ctx.fillText(s.day_type.slice(0, 7), x0, H - padB + 26);
    ctx.fillStyle = s.rf > 0 ? "#30d158" : s.rf < 0 ? "#ff453a" : "#6e6e76";
    ctx.fillText(`RF${s.rf > 0 ? "+" : ""}${s.rf}`, x0, H - padB + 38);
  });

  // composite column (merged TPO of the selection)
  const comp = d.composite.tpo;
  const cx0 = padL + sessions.length * colW + 4;
  const cUsable = colW - 12;
  const maxC = Math.max(...comp, 1);
  for (let i = 0; i < n; i++) {
    if (!inView(i) || !comp[i]) continue;
    ctx.fillStyle = i === d.composite.poc_i ? "#ffd60a"
      : (i >= d.composite.val_i && i <= d.composite.vah_i) ? "#8a6cc0" : "#564477";
    ctx.fillRect(cx0, yOf(grid[i]) - rowH / 2 + 0.5, Math.max(1.5, comp[i] / maxC * cUsable), Math.max(1, rowH - 1));
  }
  ctx.fillStyle = "#bf5af2"; ctx.font = "9.5px JetBrains Mono";
  ctx.fillText("COMPOSITE", cx0, H - padB + 14);
  ctx.fillText(`${sessions.length}d merged`, cx0, H - padB + 26);

  // trails
  if (wb.show.trail && pocTrail.length > 1) {
    ctx.strokeStyle = "rgba(255,214,10,.55)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    pocTrail.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke(); ctx.lineWidth = 1;
  }
  if (wb.show.vwap && vwapTrail.length > 1) {
    ctx.strokeStyle = "rgba(100,210,255,.45)"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    vwapTrail.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke(); ctx.lineWidth = 1;
  }

  wireWbInteract(cv, {padL, padT, padB, colW, sessions, grid, rowH, vLo, vHi, step, fullLo, fullHi, H});
}

function wireWbInteract(cv, geo) {
  const wb = wbState();
  const tip = $("#wb-tip");
  const priceAt = y => geo.vLo + (1 - (y - geo.padT) / (geo.H - geo.padT - geo.padB)) * (geo.vHi - geo.vLo);
  let dragY = null, dragged = false;

  cv.onmousemove = ev => {
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (dragY !== null) {
      const dp = priceAt(dragY) - priceAt(y);
      const span = geo.vHi - geo.vLo;
      let lo = geo.vLo + dp, hi = geo.vHi + dp;
      if (lo < geo.fullLo) { lo = geo.fullLo; hi = lo + span; }
      if (hi > geo.fullHi) { hi = geo.fullHi; lo = hi - span; }
      wb.view = [lo, hi];
      dragY = y + (priceAt(y) - priceAt(dragY)) * 0;   // anchor follows redraw
      dragged = true;
      drawWorkbench();
      return;
    }
    const si = Math.floor((x - geo.padL) / geo.colW);
    if (si < 0 || si >= geo.sessions.length || y < geo.padT || y > geo.H - geo.padB) { tip.style.display = "none"; return; }
    const s = geo.sessions[si];
    const grid = geo.grid;
    const price = priceAt(y);
    const i = Math.max(0, Math.min(grid.length - 1, Math.round((price - grid[0]) / geo.step)));
    tip.style.display = "block";
    tip.style.left = Math.min(x + 14, r.width - 240) + "px";
    tip.style.top = (y + 10) + "px";
    tip.innerHTML = `<b>${esc(s.day)}</b> · ${esc(s.day_type)}<br>
      price <b class="num">${fmt(grid[i], 4)}</b><br>
      TPO ${s.tpo[i] || 0} · vol ${fmt(s.vol[i] || 0, 0)} · Δ <span class="${cls(s.dlt[i])}">${sign(s.dlt[i] || 0)}${fmt(s.dlt[i] || 0, 0)}</span><br>
      VA ${fmt(grid[s.val_i], 2)}–${fmt(grid[s.vah_i], 2)} · POC ${fmt(s.poc_price, 2)}${s.naked ? " <span style='color:#ffd60a'>(naked)</span>" : ""}<br>
      VWAP ${fmt(s.vwap, 2)} · RF ${s.rf > 0 ? "+" : ""}${s.rf} · IB ${fmt(s.ib_pct * 100, 0)}% · close@${fmt(s.close_loc * 100, 0)}%`;
  };
  cv.onmousedown = ev => { dragY = ev.clientY - cv.getBoundingClientRect().top; dragged = false; tip.style.display = "none"; };
  cv.onmouseup = () => { dragY = null; };
  cv.onmouseleave = () => { tip.style.display = "none"; dragY = null; };
  cv.onwheel = ev => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    const y = ev.clientY - r.top;
    const anchor = priceAt(y);
    const f = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
    let lo = anchor - (anchor - geo.vLo) * f;
    let hi = anchor + (geo.vHi - anchor) * f;
    lo = Math.max(geo.fullLo, lo); hi = Math.min(geo.fullHi, hi);
    if (hi - lo > geo.step * 8) { wb.view = [lo, hi]; drawWorkbench(); }
  };
  cv.ondblclick = () => { wb.view = null; drawWorkbench(); };
  cv.onclick = ev => {
    if (dragged) { dragged = false; return; }
    const r = cv.getBoundingClientRect();
    const si = Math.floor((ev.clientX - r.left - geo.padL) / geo.colW);
    if (si >= 0 && si < geo.sessions.length && wb.session === "rth") loadWbDrill(geo.sessions[si].day);
  };
}

function renderWbStats() {
  const wb = wbState();
  const el = $("#wb-stats");
  if (!el || !wb.data) return;
  const sessions = wbVisibleSessions();
  el.innerHTML = `<div class="panel"><div class="panel-title">Session Stats <small>RF = rotation factor · click a row (or canvas column) for TPO letters</small></div>
    <div style="overflow-x:auto"><table>
    <tr><th>Session</th><th>Type</th><th>Range</th><th>IB%</th><th>RF</th><th>Delta</th><th>VWAP</th><th>Value width</th><th>Close loc</th><th>Volume</th><th>POC</th><th>Flags</th></tr>
    ${sessions.slice().reverse().map(s => `
      <tr data-day="${esc(s.day)}" style="cursor:pointer">
      <td class="num">${esc(s.day)}</td><td>${esc(s.day_type)}</td>
      <td class="num">${fmt(s.high - s.low, 2)}</td>
      <td class="num">${fmt(s.ib_pct * 100, 0)}%</td>
      <td class="num ${cls(s.rf)}">${s.rf > 0 ? "+" : ""}${s.rf}</td>
      <td class="num ${cls(s.delta_total)}">${sign(s.delta_total)}${fmt(s.delta_total, 0)}</td>
      <td class="num">${fmt(s.vwap, 2)}</td>
      <td class="num">${fmt(s.value_width, 2)}</td>
      <td class="num">${fmt(s.close_loc * 100, 0)}%</td>
      <td class="num">${fmt(s.volume_total, 0)}</td>
      <td class="num">${fmt(s.poc_price, 2)}${s.naked ? " <span class='badge fresh'>naked</span>" : ""}</td>
      <td class="small">${[s.poor_high ? "poor-high" : "", s.poor_low ? "poor-low" : ""].filter(Boolean).join(", ")}</td></tr>`).join("")}
    </table></div></div>`;
  $$("tr[data-day]", el).forEach(row => row.onclick = () => {
    if (wbState().session === "rth") loadWbDrill(row.dataset.day);
  });
}

async function loadWbDrill(day) {
  const el = $("#wb-drill");
  el.innerHTML = `<div class="loading">Loading TPO letters for ${esc(day)}…</div>`;
  try {
    const d = await api(`/profile/${state.symbol}?day=${day}`);
    if (!d.ok) throw new Error(d.error);
    const t = d.tpo;
    const tpoRows = t.rows.map(r => {
      const isPoc = r.price === t.poc, inVa = r.price <= t.vah && r.price >= t.val;
      return `<div class="tpo-row ${isPoc ? "poc" : ""} ${inVa ? "va" : ""}">
        <span class="p">${fmt(r.price, 4)}${isPoc ? " ◀POC" : r.price === t.vah ? " ◀VAH" : r.price === t.val ? " ◀VAL" : ""}</span>
        <span class="l">${esc(r.letters)}</span></div>`;
    }).join("");
    const fa = t.failed_auction;
    el.innerHTML = `
      <div class="panel"><div class="panel-title">🔍 ${esc(day)} — TPO Letters
        <small>O ${fmt(t.open, 2)} · H ${fmt(t.high, 2)} · L ${fmt(t.low, 2)} · C ${fmt(t.close, 2)} · IB ${fmt(t.ib_low, 2)}–${fmt(t.ib_high, 2)}</small>
        <button class="link" onclick="this.closest('.panel').remove()">close ✕</button></div>
        <p class="small"><b>${esc(t.day_type.type)}</b> — ${esc(t.day_type.note)}</p>
        ${fa ? `<p class="mt8 small" style="color:var(--purple)">⚑ ${esc(fa.note)}</p>` : ""}
        <div class="tpo-wrap mt8">${tpoRows}</div></div>`;
    el.scrollIntoView({behavior: "smooth", block: "start"});
  } catch (e) { el.innerHTML = errBox("Drill-down failed: " + e.message); }
}

async function loadProfileContext() {
  const el = $("#wb-context");
  try {
    const c = await api(`/composite/${state.symbol}?days=10`);
    if (!c.ok) { el.innerHTML = ""; return; }
    const mig = c.sessions.slice().reverse().map(s => `
      <tr><td class="num">${esc(s.day)}</td>
      <td>${esc(s.day_type)}</td>
      <td class="num">${fmt(s.poc, 2)}</td>
      <td class="num muted">${fmt(s.val, 2)}–${fmt(s.vah, 2)}</td>
      <td class="num">${fmt(s.close, 2)}</td>
      <td>${s.relation ? `<span class="rel ${esc(s.relation)}">${esc(s.relation_label)}</span>` : "<span class='muted'>—</span>"}</td></tr>`).join("");
    const magnet = (list, kind) => list.map(x => `
      <tr><td>${esc(kind === "npoc" ? "Naked POC" : kind === "gap" ? `Unfilled gap (${x.side})` : x.kind)}</td>
      <td class="num">${kind === "gap" ? `${fmt(x.from, 2)}–${fmt(x.to, 2)}` : fmt(x.price, 2)}</td>
      <td class="num muted">${esc(x.day)}</td>
      <td class="num ${cls(-x.distance)}">${sign(-x.distance)}${fmt(-x.distance, 2)} away</td></tr>`).join("");
    const magnets = magnet(c.naked_pocs, "npoc") + magnet(c.unfilled_gaps, "gap") + magnet(c.untested_extremes, "ext");
    el.innerHTML = `
      <div class="grid2">
        <div class="panel"><div class="panel-title">📈 Value Migration <small>the auction's trend, day over day</small></div>
          <p class="small" style="color:${c.value_trend.direction === "up" ? "var(--green)" : c.value_trend.direction === "down" ? "var(--red)" : "var(--amber)"}">
          <b>${esc(c.value_trend.note)}</b></p>
          <table class="mt8"><tr><th>Session</th><th>Type</th><th>POC</th><th>Value</th><th>Close</th><th>Relation</th></tr>${mig}</table></div>
        <div class="panel"><div class="panel-title">🧲 Magnets &amp; Unfinished Business</div>
          ${magnets ? `<table><tr><th>What</th><th>Price</th><th>From</th><th>Distance</th></tr>${magnets}</table>`
                    : `<p class="muted small">Nothing untested nearby — the market has cleaned up its business.</p>`}
          <p class="mt8 muted small">${esc(c.explainers.naked_poc)}</p></div>
      </div>`;
  } catch (e) { el.innerHTML = ""; }
}

/* ---------- calendar ---------- */
function surpriseCls(actual, forecast) {
  const num = s => parseFloat(String(s).replace(/[^0-9.eE+-]/g, ""));
  const a = num(actual), f = num(forecast);
  if (isNaN(a) || isNaN(f) || a === f) return "";
  return a > f ? "cal-beat" : "cal-miss";
}

async function loadCalendar(country) {
  const el = $("#tab-calendar");
  state.calCountry = country !== undefined ? country : (state.calCountry ?? "USD");
  el.innerHTML = `<div class="loading">Loading economic calendar…</div>`;
  try {
    const d = await api(`/calendar?days=13&country=${state.calCountry}`);
    if (!d.ok) { el.innerHTML = errBox(d.error || "calendar unavailable"); return; }
    const nowMs = Date.now();
    let lastDate = "";
    const rows = (d.events || []).map((e, i) => {
      const when = etDate(e.date, e.time);
      const past = when.getTime() < nowMs - 30 * 60000;
      const dateHdr = e.date !== lastDate
        ? `<tr><td colspan="8" style="padding-top:14px"><b>${new Date(e.date + "T12:00:00").toLocaleDateString("en-US", {weekday: "long", month: "short", day: "numeric"})}</b>${e.days_until === 0 ? ' <span class="badge high">today</span>' : ""}</td></tr>` : "";
      lastDate = e.date;
      return dateHdr + `
      <tr class="${past ? "cal-past" : ""} ${e.days_until === 0 && !past ? "cal-today" : ""}">
        <td class="num muted">${esc(e.time)}</td>
        <td class="num">${esc(e.country)}</td>
        <td><b>${esc(e.event)}</b></td>
        <td><span class="badge ${esc(e.impact)}">${esc(e.impact)}</span></td>
        <td class="num cal-actual ${surpriseCls(e.actual, e.forecast)}">${esc(e.actual || "—")}</td>
        <td class="num">${esc(e.forecast || "—")}</td>
        <td class="num muted">${esc(e.previous || "—")}</td>
        <td>${e.guide ? `<button class="info" data-info="${esc(e.guide)}">i</button>` : ""}</td>
      </tr>`;
    }).join("");
    const prints = (d.us_prints || []).map(p => `
      <div class="kpi"><div class="v" style="font-size:17px">${esc(p.value)}</div>
      <div class="k">${esc(p.name)} · ${esc(p.period)}<br>${esc(p.secondary)}</div></div>`).join("");
    el.innerHTML = `
      ${d.next_major ? `<div class="panel" style="border-color:#ffd60a44"><div class="panel-title">Next Major Release
        <button class="info" data-info="${esc(d.next_major.guide || "High-impact scheduled release.")}">i</button></div>
        <p><b class="accent">${esc(d.next_major.event)}</b> — ${esc(d.next_major.date)} ${esc(d.next_major.time)}
        ${d.next_major.forecast ? `· forecast <b class="num">${esc(d.next_major.forecast)}</b>` : ""}
        ${d.next_major.previous ? `· previous <span class="num muted">${esc(d.next_major.previous)}</span>` : ""}</p></div>` : ""}
      ${prints ? `<div class="panel"><div class="panel-title">Latest US Prints <small>actual released values · BLS</small>
        <button class="info" data-info="The most recent official readings of the data that drives Fed policy. These are the numbers the next forecasts will be measured against.">i</button></div>
        <div class="prints-row">${prints}</div></div>` : ""}
      <div class="panel"><div class="panel-title">Economic Calendar
        <span class="seg" id="cal-country">
          <button data-v="USD" ${state.calCountry === "USD" ? 'class="active"' : ""}>US only</button>
          <button data-v="" ${state.calCountry === "" ? 'class="active"' : ""}>All countries</button></span>
        <button class="info" data-info="${esc(d.how_to_read)}">i</button>
        <small>${esc(d.source === "live" ? "live feed · forecast & previous from FairEconomy" : d.source)}</small></div>
        <table><tr><th>Time</th><th>Cur</th><th>Event</th><th>Impact</th><th>Actual</th><th>Forecast</th><th>Previous</th><th></th></tr>
        ${rows || "<tr><td colspan='8' class='muted'>no events in range</td></tr>"}</table></div>`;
    $$("#cal-country button").forEach(b => b.onclick = () => loadCalendar(b.dataset.v));
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- news ---------- */
const CAT_LABEL = {"central-bank": "Central banks", "geopolitics": "Geopolitics", "energy": "Energy",
                   "data": "Data", "markets": "Markets", "other": "Other"};

function newsFilters() {
  if (!state.newsF) state.newsF = {cat: "", tier: "", q: "", seen: new Set()};
  return state.newsF;
}

function renderSquawk(d) {
  const f = newsFilters();
  const items = (d.latest || []).filter(i =>
    (!f.cat || i.category === f.cat) &&
    (!f.tier || i.tier === "critical" || i.tier === "high") &&
    (!f.q || i.title.toLowerCase().includes(f.q)));
  const html = items.slice(0, 80).map(i => `
    <div class="news-item ${f.seen.size && !f.seen.has(i.id) ? "fresh-item" : ""}">
      <span class="cat-dot cat-${esc(i.category)}" title="${esc(CAT_LABEL[i.category] || "")}"></span>
      <span class="badge ${i.tier}">${i.tier}</span>
      <span class="t"><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a></span>
      <span class="impact-chips">${i.impacts.map(x => `<span>${esc(x)}</span>`).join("")}</span>
      <span class="news-meta">${esc(i.source)} · ${i.age_min != null ? i.age_min + "m" : "—"}</span>
    </div>`).join("");
  const box = $("#squawk-stream");
  if (box) box.innerHTML = html || `<p class="muted small" style="padding:14px">No headlines match the current filters.</p>`;
  (d.latest || []).forEach(i => f.seen.add(i.id));
}

async function loadNews(refreshOnly = false) {
  const el = $("#tab-news");
  if (!refreshOnly || !$("#squawk-stream")) {
    el.innerHTML = `<div class="loading">Connecting to the wires…</div>`;
  }
  try {
    const [d, snt] = await Promise.all([api("/news"), api("/sentiment")]);
    state.newsData = d;
    if (refreshOnly && $("#squawk-stream")) { renderSquawk(d); return; }
    const f = newsFilters();

    const alerts = (d.alerts || []).map(a => `
      <div class="alert-item"><span class="badge ${a.tier}">${a.tier}</span>
        <a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a>
        <div class="news-meta mt8">${esc(a.source)} · ${a.age_min != null ? a.age_min + "m ago" : ""}
        <span class="impact-chips">${a.impacts.map(i => `<span>${esc(i)}</span>`).join("")}</span></div></div>`).join("");

    const gauges = (snt.components || []).map(c => `
      <div class="gauge-card"><div class="gv">${fmt(c.score, 0)}</div>
        <div class="gl">${esc(c.name)}</div>
        <div class="gd">${esc(c.label)} · ${esc(c.detail)}</div>
        <div class="gauge-track"><div class="pin" style="left:${Math.max(2, Math.min(98, c.score))}%"></div></div>
      </div>`).join("");

    el.innerHTML = `
      ${snt.ok ? `<div class="panel"><div class="panel-title">Market Sentiment
          <button class="info" data-info="${esc(snt.how_to_read)}">i</button>
          <small>composite ${fmt(snt.composite, 0)}/100</small></div>
        <div class="gauge-row">${gauges}</div>
        <p class="mt12 small">${esc(snt.composite_read)}</p>
        ${snt.vix ? `<p class="mt8 small muted"><b>Volatility regime (${esc(snt.vix.regime)}, VIX ${snt.vix.vix}):</b> ${esc(snt.vix.note)}</p>` : ""}</div>` : ""}
      <div class="grid2">
        <div class="panel"><div class="panel-title">Priority Alerts
          <button class="info" data-info="${esc(d.how_to_read)}">i</button>
          <small>crises · geopolitics · policy shocks</small></div>
          ${alerts || `<p class="muted small">No high-severity headlines on the wires right now.</p>`}</div>
        <div class="panel"><div class="panel-title">Live Squawk
          <small>${d.sources_ok}/${d.sources_total} wires connected · refreshes every 2 min · blue tint = new since last refresh</small></div>
          <div class="squawk-bar">
            <span class="seg" id="news-cat">
              <button data-v="" class="${!f.cat ? "active" : ""}">All</button>
              <button data-v="central-bank" class="${f.cat === "central-bank" ? "active" : ""}">CB</button>
              <button data-v="geopolitics" class="${f.cat === "geopolitics" ? "active" : ""}">Geo</button>
              <button data-v="energy" class="${f.cat === "energy" ? "active" : ""}">Energy</button>
              <button data-v="data" class="${f.cat === "data" ? "active" : ""}">Data</button>
              <button data-v="markets" class="${f.cat === "markets" ? "active" : ""}">Markets</button>
            </span>
            <span class="seg" id="news-tier">
              <button data-v="" class="${!f.tier ? "active" : ""}">All tiers</button>
              <button data-v="hot" class="${f.tier ? "active" : ""}">Hot only</button>
            </span>
            <input type="search" id="news-q" placeholder="Search headlines… (e.g. powell, oil, tariff)" value="${esc(f.q)}">
          </div>
          <div id="squawk-stream" style="max-height:600px;overflow-y:auto"></div>
          ${(d.errors || []).length ? `<p class="mt8 muted small">Unreachable: ${d.errors.map(x => esc(x.source)).join(", ")}</p>` : ""}</div>
      </div>`;
    renderSquawk(d);
    $$("#news-cat button").forEach(b => b.onclick = () => {
      $$("#news-cat button").forEach(x => x.classList.toggle("active", x === b));
      newsFilters().cat = b.dataset.v; renderSquawk(state.newsData);
    });
    $$("#news-tier button").forEach(b => b.onclick = () => {
      $$("#news-tier button").forEach(x => x.classList.toggle("active", x === b));
      newsFilters().tier = b.dataset.v; renderSquawk(state.newsData);
    });
    $("#news-q").oninput = ev => { newsFilters().q = ev.target.value.toLowerCase(); renderSquawk(state.newsData); };
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- central banks ---------- */
function drawLineChart(canvasId, seriesList, opts = {}) {
  const cv = $("#" + canvasId); if (!cv || !seriesList.length) return;
  const {ctx, W, H} = hiDPI(cv);
  const padL = 36, padB = 18, padT = 8, padR = 6;
  const all = seriesList.flatMap(s => s.points.map(p => p.v));
  if (!all.length) return;
  const min = Math.min(...all), max = Math.max(...all), span = (max - min) || 1;
  const maxLen = Math.max(...seriesList.map(s => s.points.length));
  const x = i => padL + i / Math.max(maxLen - 1, 1) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / span) * (H - padT - padB);
  ctx.font = "9.5px JetBrains Mono"; ctx.fillStyle = "#6e6e76";
  for (let g = 0; g <= 4; g++) {
    const v = min + span * g / 4, yy = y(v);
    ctx.strokeStyle = "#1d1d22"; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillText(fmt(v, 2), 2, yy + 3);
  }
  const lbls = seriesList[0].points;
  for (let i = 0; i < lbls.length; i += Math.max(1, Math.floor(lbls.length / 6))) {
    ctx.fillText(String(lbls[i].t).slice(0, 7), x(i + (maxLen - lbls.length)), H - 4);
  }
  seriesList.forEach(s => {
    const off = maxLen - s.points.length;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.beginPath();
    s.points.forEach((p, i) => i ? ctx.lineTo(x(i + off), y(p.v)) : ctx.moveTo(x(i + off), y(p.v)));
    ctx.stroke();
  });
  ctx.lineWidth = 1;
}

const CB_COLORS = {fed: "#0a84ff", ecb: "#ffd60a", boj: "#ff453a", boe: "#30d158"};

async function loadCB() {
  const el = $("#macro-body");
  el.innerHTML = `<div class="loading">Loading central-bank intelligence… (policy histories + wires, first run ~15s)</div>`;
  try {
    const [d, corr] = await Promise.all([api("/central-banks"), api("/correlations")]);
    if (!d.ok) { el.innerHTML = errBox(d.error || "central bank desk unavailable"); return; }
    const fw = d.fedwatch || {};
    const mon = d.monitor || {};

    const monAlerts = (mon.alerts || []).map(a => `<div class="brief-warning crit">${esc(a.text)}</div>`).join("");
    const monHtml = mon.ok ? `
      <div class="kpi-row">
        <div class="kpi"><div class="v ${cls(mon.current_bp)}">${sign(mon.current_bp)}${fmt(mon.current_bp, 1)}bp</div>
          <div class="k">Implied move · next FOMC (${esc(mon.meeting || "")})</div></div>
        <div class="kpi"><div class="v ${cls(mon.shift_30m)}">${mon.shift_30m == null ? "—" : sign(mon.shift_30m) + fmt(mon.shift_30m, 1) + "bp"}</div>
          <div class="k">Repricing · last 30 min</div></div>
        <div class="kpi"><div class="v ${cls(mon.shift_session)}">${mon.shift_session == null ? "—" : sign(mon.shift_session) + fmt(mon.shift_session, 1) + "bp"}</div>
          <div class="k">Repricing · this session</div></div>
      </div>
      ${(mon.history || []).length > 3 ? `<canvas id="mon-canvas" height="70"></canvas>` : `<p class="muted small">Intraday repricing history builds as the app runs — alerts fire automatically when the next meeting moves ≥3bp in 30 minutes.</p>`}`
      : `<p class="muted small">Monitor needs the ZQ feed — it activates when Fed Funds futures quotes are reachable.</p>`;

    const meetings = (fw.meetings || []).map(m => {
      if (!m.ok) return `<tr><td class="num">${esc(m.meeting)}</td><td class="num">${m.days_until}d</td><td colspan="3" class="muted small">${esc(m.error)}</td></tr>`;
      const segs = (m.scenarios || []).filter(s => s.prob > 1).map(s =>
        `<span class="prob-seg ${s.move_bp < 0 ? "cut" : s.move_bp > 0 ? "hike" : "hold"}" style="width:${Math.max(s.prob, 7)}%">${s.move_bp === 0 ? "hold" : (s.move_bp > 0 ? "+" : "") + s.move_bp + "bp"} ${fmt(s.prob, 0)}%</span>`).join("");
      return `<tr><td class="num">${esc(m.meeting)}</td><td class="num">${m.days_until}d</td>
        <td class="num">${fmt(m.implied_post_rate, 2)}%</td>
        <td class="num ${cls(m.implied_change_bp)}">${sign(m.implied_change_bp)}${fmt(m.implied_change_bp, 0)}bp</td>
        <td style="min-width:220px"><div class="prob-bar">${segs}</div></td></tr>`;
    }).join("");

    const stanceChip = s => s === "hiking" ? `<span class="badge high">hiking</span>`
      : s === "cutting" ? `<span class="badge fresh">cutting</span>` : `<span class="badge medium">holding</span>`;
    const bankCards = (d.banks || []).map(b => `
      <div class="panel bank-card">
        <div class="panel-title"><span class="cb-dot" style="background:${CB_COLORS[b.key]}"></span>${esc(b.name)}
          ${stanceChip(b.stance)}
          <button class="info" data-info="${esc(b.watch)}">i</button></div>
        <div class="bank-row">
          <div><div class="v num" style="font-size:26px;font-weight:700">${b.rate != null ? fmt(b.rate, 2) + "%" : "—"}</div>
            <div class="muted small">policy rate${b.rate_1y_ago != null ? ` · 1y ago ${fmt(b.rate_1y_ago, 2)}%` : ""}</div></div>
          <canvas id="spark-${b.key}" class="spark" height="46" style="max-width:160px"></canvas>
        </div>
        <div class="small mt8">
          ${b.next_meeting ? `Next decision: <b>${esc(b.next_meeting.date)}</b> (${b.next_meeting.days_until}d)${b.next_meeting.approx ? " <span class='muted'>~verify</span>" : ""} · <span class="muted">${esc(b.decision_time)}</span>` : ""}
        </div>
        ${b.fx ? `<div class="small mt8">Market lens: <b class="num">${esc(b.fx.symbol)}</b> ${fmt(b.fx.last, 5)}
          <span class="${cls(b.fx.change_pct)} num">${sign(b.fx.change_pct)}${fmt(b.fx.change_pct, 2)}%</span>
          <span class="muted">— this future reprices ${esc(b.short)} expectations in real time</span></div>` : ""}
        ${(b.news || []).length ? `<div class="mt8">${b.news.slice(0, 4).map(nn => `
          <div class="news-item" style="padding:6px 2px"><span class="t small"><a href="${esc(nn.link)}" target="_blank" rel="noopener">${esc(nn.title)}</a></span>
          <span class="news-meta">${nn.age_min != null ? nn.age_min + "m" : ""}</span></div>`).join("")}</div>`
          : `<p class="muted small mt8">wires unreachable right now</p>`}
      </div>`).join("");

    const div = (d.divergences || []).map(v => `
      <div class="setup-card"><h4>${esc(v.pair)}: <span class="num">${sign(v.differential)}${fmt(v.differential, 2)}%</span>
        <code>${esc(v.fx_future)}</code></h4>
      <p class="small mt8">${esc(v.read)}</p></div>`).join("");

    const yc = d.yield_curve || {};
    const ycHtml = yc.ok ? (yc.points || []).map(p =>
      `<span class="num" style="margin-right:18px"><b>${esc(p.tenor)}</b> ${fmt(p.yield, 2)}% <span class="${cls(p.chg_bp)}">${sign(p.chg_bp)}${fmt(p.chg_bp, 1)}bp</span></span>`).join("")
      + (yc.spread_3m10y_bp != null ? `<p class="mt8 small">3M/10Y spread: <b class="${cls(yc.spread_3m10y_bp)}">${fmt(yc.spread_3m10y_bp, 0)}bp</b>${yc.spread_3m10y_bp < 0 ? " (inverted — historically a recession signal)" : ""}</p>` : "")
      : `<span class="muted small">yield data unavailable</span>`;

    let corrHtml = "";
    if (corr.ok) {
      const color = v => v == null ? "#1d2733" : v > 0 ? `rgba(48,209,88,${Math.abs(v) * 0.55})` : `rgba(255,69,58,${Math.abs(v) * 0.55})`;
      corrHtml = `<div style="overflow-x:auto"><table><tr><th></th>${corr.symbols.map(s => `<th class="num">${esc(s)}</th>`).join("")}</tr>` +
        corr.symbols.map((s, i) => `<tr><th class="num">${esc(s)}</th>` +
          corr.matrix[i].map(v => `<td class="corr-cell" style="background:${color(v)}">${v == null ? "—" : v.toFixed(2)}</td>`).join("") + "</tr>").join("") + "</table></div>";
      if ((corr.regime_shifts || []).length) corrHtml += `<div class="mt12"><b>Regime shifts (vs prior ${corr.window}d)</b><ul class="clean small">` +
        corr.regime_shifts.map(r => `<li><b>${esc(r.pair)}</b>: ${r.before.toFixed(2)} → ${r.now.toFixed(2)}</li>`).join("") + `</ul></div>`;
    }

    el.innerHTML = `
      ${monAlerts}
      <div class="panel"><div class="panel-title">⚡ Live Repricing Monitor
        <button class="info" data-info="Tracks the market-implied size of the next Fed decision, recomputed from Fed Funds futures every minute the app is open. When new information hits (a data print, a headline, a speech), this number moves FIRST — before most charts make it obvious. A ≥3bp repricing in 30 minutes fires an alert anywhere in the app.">i</button>
        <small>implied next-meeting move, recomputed continuously</small></div>${monHtml}</div>
      <div class="panel"><div class="panel-title">Fed — Implied Rate Path
        <button class="info" data-info="${esc(fw.method || "")} Each bar splits probability between the two nearest 25bp outcomes. Trade the GAP between this pricing and what gets delivered — and watch it reprice in real time on data releases.">i</button>
        <small>current implied rate: <b class="num">${fmt(fw.current_implied_rate, 2)}%</b></small></div>
        <table><tr><th>Meeting</th><th>In</th><th>Implied rate after</th><th>Move priced</th><th>Probabilities</th></tr>${meetings}</table></div>
      <div class="grid2">${bankCards}</div>
      <div class="panel"><div class="panel-title">Policy Rates — 10 Years, All Four Banks
        <button class="info" data-info="Official policy rates from BIS data. The SPREAD between lines is what currency futures price: a widening Fed–BoJ gap historically means a falling 6J (weaker yen). When one line starts turning while another keeps going, the FX future between them usually trends for months — and repricings of that path are tradable intraday around their meetings.">i</button>
        <small>${Object.entries(CB_COLORS).map(([k, c]) => `<span class="lg" style="background:${c}"></span>${k.toUpperCase()}`).join(" ")}</small></div>
        <canvas id="cb-history" height="220"></canvas></div>
      ${div ? `<div class="panel"><div class="panel-title">Rate Differentials → FX Futures
        <button class="info" data-info="Currencies follow rate differentials. These cards turn the policy-rate gaps into the futures contract they drive, so a central-bank surprise can be traded through the cleanest instrument.">i</button></div>
        <div class="grid3">${div}</div></div>` : ""}
      <div class="grid2">
        <div class="panel"><div class="panel-title">US Yield Curve</div>${ycHtml}</div>
        <div class="panel"><div class="panel-title">${esc((d.prep_process || {}).title || "Prep")}</div>
          <ul class="clean small">${((d.prep_process || {}).items || []).map(i => `<li>${esc(i)}</li>`).join("")}</ul></div>
      </div>
      ${corrHtml ? `<div class="panel"><div class="panel-title">Cross-Asset Correlations <small>rolling ${corr.window}d · green +, red −</small></div>${corrHtml}</div>` : ""}
      <p class="muted small">${esc(d.how_to_read || "")}</p>`;

    // draw canvases
    (d.banks || []).forEach(b => {
      if ((b.history || []).length > 3)
        drawLineChart(`spark-${b.key}`, [{color: CB_COLORS[b.key],
          points: b.history.slice(-60).map(h => ({t: h.period, v: h.rate}))}]);
    });
    const hist = (d.banks || []).filter(b => (b.history || []).length > 3)
      .map(b => ({color: CB_COLORS[b.key], points: b.history.map(h => ({t: h.period, v: h.rate}))}));
    if (hist.length) drawLineChart("cb-history", hist);
    if ((mon.history || []).length > 3)
      drawLineChart("mon-canvas", [{color: "#0a84ff",
        points: mon.history.map(h => ({t: new Date(h.t * 1000).toLocaleTimeString("en-US", {hour: "2-digit", minute: "2-digit"}), v: h.bp}))}]);
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- flow ---------- */
async function loadFlow() {
  const el = $("#macro-body");
  el.innerHTML = `<div class="loading">Computing dealer gamma for ${state.symbol}… (option chains take ~10s)</div>`;
  try {
    const d = await api(`/flow?symbol=${state.symbol}`);
    if (!d.gex) { el.innerHTML = errBox(d.error || "flow unavailable"); return; }
    const g = d.gex;
    let gexHtml;
    if (g.ok) {
      const maxAbs = Math.max(...g.strikes.map(s => Math.abs(s.net_gex)), 1);
      const rows = g.strikes.filter(s => Math.abs(s.net_gex) > maxAbs * 0.02).map(s => {
        const w = Math.abs(s.net_gex) / maxAbs * 100;
        const pos = s.net_gex >= 0;
        return `<div class="vp-row"><span class="p">${fmt(s.strike, 1)}</span>
          <div style="width:50%;display:flex;justify-content:flex-end">${!pos ? `<div class="bar" style="width:${w}%;background:#a83a4e"></div>` : ""}</div>
          <div style="width:50%">${pos ? `<div class="bar" style="width:${w}%;background:#2e9e6b"></div>` : ""}</div></div>`;
      }).join("");
      gexHtml = `
        <p><b>Regime: <span class="${g.regime === "positive" ? "gex-pos" : "gex-neg"}">${esc(g.regime)} gamma</span></b>
        <span class="muted small">· proxy ${esc(g.proxy)} spot ${fmt(g.spot, 2)} · zero-gamma flip ≈ <b>${fmt(g.zero_gamma, 0)}</b> ·
        max pain (front) ${fmt(g.max_pain_front, 0)} · put/call OI ${fmt(g.put_call_oi_ratio, 2)}</span></p>
        <p class="mt8 small">${esc(g.read)}</p>
        <div class="mt12 small muted">Net GEX by strike — red left = put-dominated (negative), green right = call-dominated (positive)</div>
        <div class="mt8">${rows}</div>
        <p class="mt8 muted small">Computed from free ${esc(g.proxy)} option chains (expiries: ${(g.expiries_used || []).slice(0, 4).map(esc).join(", ")}…). Translate proxy strikes to futures levels proportionally.</p>`;
    } else {
      gexHtml = errBox("GEX unavailable: " + (g.error || ""),
        ["ES","NQ","RTY"].includes(state.symbol) ? "Option chains may be rate-limited — retry shortly." : "GEX is computed for index futures (ES/NQ/RTY) via their ETF proxies.");
    }
    el.innerHTML = `
      <div class="panel"><div class="panel-title">Dealer Gamma Exposure — <span class="accent">${esc(state.symbol)}</span></div>${gexHtml}</div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Expiration / Flow Calendar</div>
          <table><tr><th>Date</th><th>In</th><th>Event</th><th>Impact</th><th></th></tr>
          ${(d.expirations || []).map(e => `<tr><td class="num">${esc(e.date)}</td><td class="num">${e.days_until}d</td>
            <td><b>${esc(e.event)}</b></td><td><span class="badge ${e.impact}">${e.impact}</span></td>
            <td class="muted small">${esc(e.note)}</td></tr>`).join("")}</table></div>
        <div class="panel"><div class="panel-title">Flow Playbook</div>
          <ul class="clean">${(d.playbook || []).map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>
      </div>`;
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- strategy library ---------- */
async function loadPlaybooks() {
  const el = $("#tab-playbooks");
  el.innerHTML = `<div class="loading">Loading strategy library…</div>`;
  try {
    const d = await api("/playbooks");
    if (!d.setups) { el.innerHTML = errBox(d.error || "library unavailable"); return; }
    el.innerHTML = `
      <div class="panel"><div class="panel-title">Strategy Library
        <button class="info" data-info="Each card is a complete setup: the market context it needs, the trigger that confirms it, where the entry, stop and target belong, and the mechanism that makes it work. Tag your journal trades with the setup id (shown as code) to measure which of these actually carries your edge.">i</button>
        <small>auction-market setups for futures intraday trading</small></div>
        <div class="grid3">${d.setups.map(s => `
          <div class="setup-card"><h4>${esc(s.name)}</h4>
          <div class="meta"><b>id:</b> <code>${esc(s.id)}</code></div>
          <div class="meta mt8"><b>Context:</b> ${esc(s.context)}</div>
          <div class="meta"><b>Trigger:</b> ${esc(s.trigger)}</div>
          <div class="meta"><b>Entry:</b> ${esc(s.entry)}</div>
          <div class="meta"><b>Stop:</b> ${esc(s.stop)} · <b>Target:</b> ${esc(s.target)}</div>
          <div class="why">Why it works: ${esc(s.why)}</div></div>`).join("")}</div></div>`;
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- journal ---------- */
async function loadJournal() {
  const el = $("#tab-journal");
  el.innerHTML = `<div class="loading">Opening journal…</div>`;
  try {
    const [m, t, pb] = await Promise.all([api("/journal/metrics"), api("/journal/trades"), api("/playbooks")]);
    if (!m.ok) { el.innerHTML = errBox(m.error || "journal unavailable"); return; }
    const setupOpts = (pb.setups || []).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    const kpis = m.count ? `
      <div class="kpi-row">
        <div class="kpi"><div class="v ${cls(m.net_pnl)}">$${fmt(m.net_pnl)}</div><div class="k">Net P&L (${m.count} trades)</div></div>
        <div class="kpi"><div class="v ${cls(m.expectancy_usd)}">$${fmt(m.expectancy_usd)}</div><div class="k">Expectancy / trade</div></div>
        <div class="kpi"><div class="v">${fmt(m.profit_factor)}</div><div class="k">Profit factor</div></div>
        <div class="kpi"><div class="v">${fmt(m.win_rate, 1)}%</div><div class="k">Win rate — one input, not the verdict</div></div>
        <div class="kpi"><div class="v ${cls(m.avg_r)}">${fmt(m.avg_r)}R</div><div class="k">Avg R-multiple</div></div>
        <div class="kpi"><div class="v down">−$${fmt(m.max_drawdown)}</div><div class="k">Max drawdown</div></div>
      </div>` : `<div class="panel"><p class="muted">No trades yet — log your first trade below. Metrics follow the Day 1 rule: combined key metrics, never win rate alone.</p></div>`;
    const audits = (m.principle_audit || []).map(a => `<div class="audit">${esc(a)}</div>`).join("");
    const bySetup = (m.by_setup || []).length ? `
      <table class="mt8"><tr><th>Setup</th><th>N</th><th>P&L</th><th>Win%</th><th>Avg R</th></tr>
      ${m.by_setup.map(s => `<tr><td>${esc(s.setup)}</td><td class="num">${s.n}</td>
        <td class="num ${cls(s.pnl)}">$${fmt(s.pnl)}</td><td class="num">${s.win_rate}%</td>
        <td class="num">${fmt(s.avg_r)}</td></tr>`).join("")}</table>` : "";
    const rows = (t.trades || []).map(x => `
      <tr><td class="num small">${esc(x.ts)}</td><td><b>${esc(x.symbol)}</b></td>
      <td class="${x.direction === "long" ? "up" : "down"}">${esc(x.direction)}</td>
      <td class="small">${esc(x.setup || "—")}</td>
      <td class="num">${fmt(x.entry, 4)} → ${fmt(x.exit, 4)}</td>
      <td class="num ${cls(x.pnl_usd)}">$${fmt(x.pnl_usd)}</td>
      <td class="num ${cls(x.r_multiple)}">${x.r_multiple != null ? fmt(x.r_multiple) + "R" : "—"}</td>
      <td class="small muted">${[x.planned ? "" : "impulse", x.followed_plan ? "" : "off-plan", x.style_drift ? "drift" : ""].filter(Boolean).join(", ")}</td>
      <td><button class="danger-link" data-del="${x.id}" title="Delete">✕</button></td></tr>`).join("");
    el.innerHTML = `
      ${kpis}
      ${audits ? `<div class="panel"><div class="panel-title">⚠ Principles Audit <small>where the program rules are leaking</small></div>${audits}</div>` : ""}
      <div class="grid2">
        <div class="panel"><div class="panel-title">Equity Curve</div><canvas id="eq-canvas" height="190"></canvas>
          ${bySetup ? `<div class="mt12"><b>Edge by setup</b>${bySetup}</div>` : ""}</div>
        <div class="panel"><div class="panel-title">Log Trade <small>30 seconds, right after you flatten</small></div>
          <form class="trade-form" id="trade-form">
            <div><label>Symbol</label><select name="symbol">${SYMBOLS.map(s => `<option ${s === state.symbol ? "selected" : ""}>${s}</option>`).join("")}</select></div>
            <div><label>Direction</label><select name="direction"><option>long</option><option>short</option></select></div>
            <div><label>Setup</label><select name="setup"><option value="">(untagged)</option>${setupOpts}</select></div>
            <div><label>Contracts</label><input name="contracts" type="number" step="1" value="1"></div>
            <div><label>Entry</label><input name="entry" type="number" step="any" required></div>
            <div><label>Stop</label><input name="stop" type="number" step="any"></div>
            <div><label>Target</label><input name="target" type="number" step="any"></div>
            <div><label>Exit</label><input name="exit" type="number" step="any" required></div>
            <div><label>Planned?</label><select name="planned"><option value="1">yes</option><option value="0">no (impulse)</option></select></div>
            <div><label>Followed plan?</label><select name="followed_plan"><option value="1">yes</option><option value="0">no</option></select></div>
            <div><label>Style drift?</label><select name="style_drift"><option value="0">no</option><option value="1">yes (scalp↔swing)</option></select></div>
            <div class="full"><label>Notes — what did the market tell you?</label><textarea name="notes" rows="2"></textarea></div>
            <div class="full"><button class="primary" type="submit">Log trade</button> <span id="trade-msg" class="muted small"></span></div>
          </form></div>
      </div>
      <div class="panel"><div class="panel-title">Trade Log</div>
        <div style="max-height:420px;overflow-y:auto"><table>
        <tr><th>Time</th><th>Sym</th><th>Dir</th><th>Setup</th><th>Entry→Exit</th><th>P&L</th><th>R</th><th>Flags</th><th></th></tr>
        ${rows || "<tr><td colspan=9 class='muted'>no trades yet</td></tr>"}</table></div></div>`;
    if (m.count) drawEquity(m.equity_curve);
    $("#trade-form").onsubmit = async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const body = Object.fromEntries(fd.entries());
      ["planned", "followed_plan", "style_drift"].forEach(k => body[k] = body[k] === "1");
      const r = await fetch("/api/journal/trades", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      const j = await r.json();
      if (j.ok) loadJournal();
      else $("#trade-msg").textContent = j.error || "failed";
    };
    $$("button[data-del]", el).forEach(b => b.onclick = async () => {
      await fetch(`/api/journal/trades/${b.dataset.del}`, {method: "DELETE"});
      loadJournal();
    });
  } catch (e) { el.innerHTML = errBox(e.message); }
}

function drawEquity(curve) {
  const cv = $("#eq-canvas"); if (!cv || !curve || !curve.length) return;
  const {ctx, W, H} = hiDPI(cv);
  const pad = 10;
  const vals = curve.map(c => c.equity);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = (max - min) || 1;
  const x = i => pad + i / Math.max(curve.length - 1, 1) * (W - 2 * pad);
  const y = v => H - pad - (v - min) / span * (H - 2 * pad);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#2a3a4d"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - pad, y(0)); ctx.stroke();
  ctx.setLineDash([]);
  const up = vals[vals.length - 1] >= 0;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, up ? "#34d39933" : "#fb5d6c33"); grad.addColorStop(1, "transparent");
  ctx.beginPath();
  curve.forEach((c, i) => i ? ctx.lineTo(x(i), y(c.equity)) : ctx.moveTo(x(i), y(c.equity)));
  ctx.strokeStyle = up ? "#34d399" : "#fb5d6c"; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(x(curve.length - 1), y(min)); ctx.lineTo(x(0), y(min)); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
}

/* ---------- trade panel (DOM + simulated account) ---------- */
let domBusy = false;

function loadTrade() {
  const panel = $("#dom-panel");
  if (!panel.dataset.init) {
    panel.dataset.init = "1";
    panel.innerHTML = `
      <div class="panel-title">DOM — <span class="accent">${esc(state.symbol)}</span>
        <button class="info" data-info="A trading ladder for execution practice. The PRICE is real (anchored to the live/delayed quote); the resting bid/ask sizes are SIMULATED with realistic behavior — icebergs that refill, large orders that get pulled, stop-runs through session extremes — so you can train DOM reading and order placement. Click a blue bid cell to place a buy (limit below price, stop above); click a red ask cell to place a sell. Fills, brackets and P&L run on a simulated 100k account and closed trades flow into your Journal automatically.">i</button>
        <small id="dom-src"></small></div>
      <div class="dom-controls">
        <div><label>Qty</label><input id="dom-qty" type="number" value="1" min="1" max="50"></div>
        <div><label>Stop (ticks)</label><input id="dom-sl" type="number" value="16" min="0"></div>
        <div><label>Target (ticks)</label><input id="dom-tp" type="number" value="32" min="0"></div>
        <button class="btn-buy" id="dom-mb">Buy Mkt</button>
        <button class="btn-sell" id="dom-ms">Sell Mkt</button>
        <button class="btn-flat" id="dom-fl">Flatten</button>
      </div>
      <div id="dom-ladder" style="max-height:640px;overflow-y:auto"><div class="loading">Connecting…</div></div>`;
    $("#dom-mb").onclick = () => placePaperOrder("buy", "market", null);
    $("#dom-ms").onclick = () => placePaperOrder("sell", "market", null);
    $("#dom-fl").onclick = async () => {
      await fetch("/api/paper/flatten", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({symbol: state.symbol})});
      pollDom(); loadPaperDash();
    };
  }
  $("#dom-panel .panel-title .accent").textContent = state.symbol;
  pollDom();
  loadPaperDash();
}

async function pollDom() {
  if (domBusy || state.tab !== "trade") return;
  domBusy = true;
  try {
    const d = await api(`/dom/${state.symbol}`);
    if (!d.ok) { $("#dom-ladder").innerHTML = errBox(d.error || "DOM unavailable"); return; }
    state.dom = d;
    renderLadder(d);
    renderDomAccount(d);
    renderDomSide(d);
  } catch (e) { /* transient */ }
  finally { domBusy = false; }
}

function renderLadder(d) {
  const acct = d.account || {};
  const myByPrice = {};
  (acct.open_orders || []).forEach(o => {
    const k = Number(o.price).toFixed(6);
    (myByPrice[k] = myByPrice[k] || []).push(o);
  });
  const maxVol = Math.max(...d.ladder.map(l => l.vol), 1);
  const dp = d.tick < 0.01 ? 5 : d.tick < 1 ? 2 : 0;
  const pocPrice = d.poc;
  const rows = d.ladder.map(l => {
    const isLast = Math.abs(l.price - d.last) < d.tick / 2;
    const isPos = acct.position && acct.avg_price && Math.abs(l.price - acct.avg_price) < d.tick / 2;
    const isVwap = d.vwap && Math.abs(l.price - d.vwap) < d.tick / 2;
    const isPoc = pocPrice != null && Math.abs(l.price - pocPrice) < d.tick / 2;
    const mine = myByPrice[Number(l.price).toFixed(6)] || [];
    const myBuy = mine.filter(o => o.side === "buy");
    const mySell = mine.filter(o => o.side === "sell");
    const myCell = arr => arr.length
      ? `<td class="d-my" data-cancel="${arr[0].id}" title="click to cancel">${arr.reduce((s, o) => s + o.qty, 0)}${arr[0].otype === "stop" ? "s" : ""}</td>`
      : `<td class="d-my"></td>`;
    return `<tr class="${isLast ? "d-last" : ""} ${isPos ? "d-pos" : ""} ${l.ice ? "d-ice" : ""} ${isVwap ? "d-vwap" : ""}">
      ${myCell(myBuy)}
      <td class="d-bid" data-side="buy" data-price="${l.price}">${l.bid || ""}</td>
      <td class="d-price"><span>${fmt(l.price, dp)}${isVwap ? " ◆" : ""}</span></td>
      <td class="d-ask" data-side="sell" data-price="${l.price}">${l.ask || ""}</td>
      ${myCell(mySell)}
      <td class="d-vp"><div class="d-vpbar ${isPoc ? "poc" : ""}" style="width:${Math.max(l.vol / maxVol * 100, l.vol ? 3 : 0)}%"></div></td>
    </tr>`;
  }).join("");
  const imb = d.imbalance != null ? d.imbalance : 50;
  $("#dom-ladder").innerHTML = `
    <div class="imb-wrap" title="Visible resting bids vs asks across the ladder. A heavy skew means one side is showing more size - but remember from the signal feed: shown size can be pulled.">
      <span class="small num up">${fmt(imb, 0)}%</span>
      <div class="imb-bar"><div style="width:${imb}%"></div></div>
      <span class="small num down">${fmt(100 - imb, 0)}%</span>
    </div>
    <table class="dom-table">
    <tr><th style="width:42px">B-ord</th><th>Bids</th><th>Price</th><th>Asks</th><th style="width:42px">S-ord</th><th style="width:64px">Profile</th></tr>
    ${rows}</table>
    <div class="muted" style="font-size:10.5px;margin-top:5px">◆ session VWAP · amber profile bar = POC · gold-edged row = iceberg level</div>`;
  $("#dom-src").textContent = `${d.source}${d.simulated_book ? " · book simulated (training)" : ""}`;
  $$("#dom-ladder .d-bid, #dom-ladder .d-ask").forEach(td => td.onclick = () => {
    const price = parseFloat(td.dataset.price);
    const side = td.dataset.side;
    const last = state.dom.last;
    let otype = "limit";
    if (side === "buy" && price > last) otype = "stop";
    if (side === "sell" && price < last) otype = "stop";
    placePaperOrder(side, otype, price);
  });
  $$("#dom-ladder [data-cancel]").forEach(td => td.onclick = async () => {
    await fetch(`/api/paper/cancel/${td.dataset.cancel}`, {method: "POST"});
    pollDom();
  });
}

async function placePaperOrder(side, otype, price) {
  const qty = parseInt($("#dom-qty").value, 10) || 1;
  const slT = parseInt($("#dom-sl").value, 10) || 0;
  const tpT = parseInt($("#dom-tp").value, 10) || 0;
  const tick = state.dom ? state.dom.tick : 0.25;
  const ref = price != null ? price : (state.dom ? state.dom.last : null);
  const dir = side === "buy" ? 1 : -1;
  const body = {symbol: state.symbol, side, qty, otype, price};
  if (ref != null && slT > 0) body.stop_loss = ref - dir * slT * tick;
  if (ref != null && tpT > 0) body.take_profit = ref + dir * tpT * tick;
  const r = await fetch("/api/paper/order", {method: "POST",
    headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  const j = await r.json();
  if (!j.ok) showToast({kind: "headline", id: "ord" + Date.now(), text: "Order rejected: " + (j.error || "")});
  pollDom();
}

function renderDomAccount(d) {
  const a = d.account || {};
  $("#dom-acct").innerHTML = `
    <div class="panel-title">Simulated Account
      <button class="info" data-info="A 100k practice account. Position size, stops and targets behave like real bracket orders: the entry activates an OCO pair (one cancels the other). Every closed round-trip is logged into your Journal tagged sim-dom, so your practice shows up in your real performance review. On the shared web deployment the account resets periodically — run locally or on Render for persistence.">i</button></div>
    <div class="acct-strip">
      <span>Equity <b class="${cls(a.equity - 100000)}">$${fmt(a.equity)}</b></span>
      <span>Open P&L <b class="${cls(a.unrealized)}">${sign(a.unrealized)}$${fmt(Math.abs(a.unrealized))}</b></span>
      <span>Realized <b class="${cls(a.realized)}">${sign(a.realized)}$${fmt(Math.abs(a.realized))}</b></span>
      ${d.vwap ? `<span>VWAP <b class="num">${fmt(d.vwap, 2)}</b></span>` : ""}
    </div>
    <div class="small">Position: <b class="num ${cls(a.position)}">${a.position > 0 ? "+" : ""}${a.position || 0}</b>
      ${a.position ? `@ <span class="num">${fmt(a.avg_price, 2)}</span>` : "(flat)"}
      · open orders: ${(a.open_orders || []).length}</div>`;
}

function renderDomSide(d) {
  const sigs = (d.signals || []).slice(0, 6).map(s =>
    `<div class="sig-item ${esc(s.kind)}">${esc(s.text)}</div>`).join("");
  const tape = (d.tape || []).map(t =>
    `<div class="tape-row ${esc(t.side)}"><span>${fmt(t.price, 2)}</span><span>×${t.size}</span></div>`).join("");
  $("#dom-side").innerHTML = `
    <div class="panel-title">Flow Analytics
      <button class="info" data-info="Cumulative delta = net aggressive buying minus selling on this tape. Cancel ratio = how much resting size gets pulled vs added (high values = spoofy, untrustworthy book). The signal feed flags icebergs (size that refills after every hit = a large passive player), big cancellations, and stop-runs through session extremes — the three order-flow events that matter most at a level.">i</button></div>
    <div class="small num">Δ cum <b class="${cls(d.cum_delta)}">${sign(d.cum_delta)}${fmt(d.cum_delta, 0)}</b>
      · cancel ratio <b>${fmt(d.cancel_ratio, 2)}</b>
      · POC <b>${fmt(d.poc, 2)}</b></div>
    <canvas id="dom-delta" height="56"></canvas>
    <div class="mt8"><b class="small">Signal feed</b>${sigs || "<p class='muted small'>watching the book…</p>"}</div>
    <div class="mt8"><b class="small">Tape</b><div style="max-height:170px;overflow-y:auto">${tape}</div></div>
    <p class="muted small mt8">${esc(d.note)}</p>`;
  if ((d.delta_hist || []).length > 2)
    drawLineChart("dom-delta", [{color: d.cum_delta >= 0 ? "#30d158" : "#ff453a",
      points: d.delta_hist.map((v, i) => ({t: i, v}))}]);
}

async function loadPaperDash() {
  const el = $("#paper-dash");
  try {
    const d = await api("/paper/dashboard");
    if (!d.ok) { el.innerHTML = ""; return; }
    if (!d.count) {
      el.innerHTML = `<div class="panel"><p class="muted small">${esc(d.note || "No sim trades yet.")}</p></div>`;
      return;
    }
    el.innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><div class="v ${cls(d.net_pnl)}">$${fmt(d.net_pnl)}</div><div class="k">Sim net P&L (${d.count} round-trips)</div></div>
        <div class="kpi"><div class="v">$${fmt(d.balance)}</div><div class="k">Balance</div></div>
        <div class="kpi"><div class="v">${fmt(d.win_rate, 1)}%</div><div class="k">Win rate</div></div>
        <div class="kpi"><div class="v">${fmt(d.profit_factor)}</div><div class="k">Profit factor</div></div>
        <div class="kpi"><div class="v up">$${fmt(d.avg_win)}</div><div class="k">Avg win</div></div>
        <div class="kpi"><div class="v down">$${fmt(d.avg_loss)}</div><div class="k">Avg loss</div></div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Sim Equity Curve</div><canvas id="paper-eq" height="170"></canvas>
          <button class="danger-link mt8" id="paper-reset">reset simulated account</button></div>
        <div class="panel"><div class="panel-title">Recent Round-Trips <small>also logged in Journal as sim-dom</small></div>
          <div style="max-height:230px;overflow-y:auto"><table>
          <tr><th>Time</th><th>Sym</th><th>Side</th><th>Qty</th><th>Entry→Exit</th><th>P&L</th></tr>
          ${d.recent.map(t => `<tr><td class="num small">${esc(t.ts.slice(5, 16))}</td><td><b>${esc(t.symbol)}</b></td>
            <td class="${t.side === "long" ? "up" : "down"}">${esc(t.side)}</td><td class="num">${t.qty}</td>
            <td class="num">${fmt(t.entry, 2)} → ${fmt(t.exit, 2)}</td>
            <td class="num ${cls(t.pnl)}">$${fmt(t.pnl)}</td></tr>`).join("")}</table></div></div>
      </div>`;
    drawEquity(d.equity_curve);
    const eqCv = $("#paper-eq");
    if (eqCv) {
      const {ctx, W, H} = hiDPI(eqCv);
      const vals = d.equity_curve.map(c => c.equity);
      const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
      ctx.strokeStyle = d.net_pnl >= 0 ? "#30d158" : "#ff453a"; ctx.lineWidth = 2; ctx.beginPath();
      vals.forEach((v, i) => {
        const x = 8 + i / Math.max(vals.length - 1, 1) * (W - 16);
        const y = 8 + (1 - (v - min) / span) * (H - 16);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    const rb = $("#paper-reset");
    if (rb) rb.onclick = async () => {
      if (!confirm("Reset the simulated account? All sim round-trips are wiped (journal copies stay).")) return;
      await fetch("/api/paper/reset", {method: "POST"});
      loadPaperDash(); pollDom();
    };
  } catch (e) { /* best effort */ }
}

/* ---------- rithmic connection ---------- */
async function loadRithmic() {
  const body = $("#rithmic-body");
  if (!body) return;
  // Never clobber the credentials form while the user is interacting with it:
  // the Markets tab auto-refreshes every 15s and a re-render would collapse
  // the form and wipe whatever was typed.
  const det = body.querySelector("details");
  const focusedInside = document.activeElement && body.contains(document.activeElement);
  const typed = ["#rith-user", "#rith-pass"].some(sel => { const el = $(sel); return el && el.value; });
  if (focusedInside || (det && det.open) || typed) return;
  try {
    const s = await api("/rithmic/status");
    if (s.connected) {
      const ticks = Object.entries(s.ticks || {}).map(([sym, t]) =>
        `<div class="small num">${esc(sym)}: ${fmt(t.last, 4)} <span class="muted">(${fmt(t.bid, 2)} × ${fmt(t.ask, 2)})</span></div>`).join("");
      body.innerHTML = `<div><span class="live-dot"></span> <b>LIVE — Rithmic (${esc(s.system)})</b>
        <span class="muted small">as ${esc(s.user)} · up ${fmt((s.uptime_s || 0) / 60, 0)}m</span></div>
        <div class="mt8">${ticks || "<span class='muted small'>waiting for first ticks…</span>"}</div>
        <button class="danger-link mt8" id="rith-disc">disconnect</button>`;
      $("#rith-disc").onclick = async () => { await fetch("/api/rithmic/disconnect", {method: "POST"}); loadRithmic(); };
      return;
    }
    const blocked = s.serverless
      ? `<p class="small" style="color:var(--amber)">This deployment is serverless, which cannot hold a live broker socket. Deploy EdgeDesk's included Render blueprint (README → "Always-on deployment", free tier) to get a web instance that connects Rithmic directly in the browser — no local install needed.</p>` : "";
    const lib = !s.lib_installed
      ? `<p class="muted small">${esc(s.lib_info)}</p>` : "";
    body.innerHTML = `
      <div><span class="src-dot"></span> Delayed data (Yahoo) ${s.connecting ? "· <b class='accent'>connecting…</b>" : ""}</div>
      ${s.error ? `<p class="small" style="color:var(--red)">${esc(s.error)}</p>` : ""}
      ${blocked}${lib}
      <details class="mt8"><summary class="small" style="cursor:pointer;color:var(--blue)">Connect Rithmic credentials (Apex, Lucid, TPT…)</summary>
        <div class="sizer mt8">
          <div style="grid-column:1/-1"><label>Rithmic user</label><input id="rith-user" autocomplete="off"></div>
          <div style="grid-column:1/-1"><label>Password</label><input id="rith-pass" type="password" autocomplete="off"></div>
          <div style="grid-column:1/-1"><label>System</label><select id="rith-sys">${(s.systems || []).map(x => `<option>${esc(x)}</option>`).join("")}</select></div>
          <div style="grid-column:1/-1"><label>Gateway region</label><select id="rith-gw">
            ${Object.entries(s.gateways || {}).map(([n, u]) => `<option value="${esc(u)}">${esc(n)}</option>`).join("")}
          </select></div>
        </div>
        <button class="primary mt8" id="rith-conn" style="width:100%">Connect</button>
        <p class="muted small mt8">Credentials are stored only on the machine running EdgeDesk (data/rithmic.json, never committed or sent anywhere except Rithmic). Once connected, live ticks replace delayed quotes — the first step toward full DOM, tick delta and order routing.</p>
      </details>`;
    const btn = $("#rith-conn");
    if (btn) btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Connecting…";
      const r = await fetch("/api/rithmic/connect", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({user: $("#rith-user").value, password: $("#rith-pass").value,
          system: $("#rith-sys").value, gateway: $("#rith-gw") ? $("#rith-gw").value : ""})});
      const j = await r.json();
      if (!j.ok) { body.insertAdjacentHTML("beforeend", errBox(j.error)); btn.disabled = false; btn.textContent = "Connect"; }
      else {
        // clear the submitted credentials and close the form so the
        // interaction guard lets the next status poll re-render
        $("#rith-user").value = "";
        $("#rith-pass").value = "";
        const dd = body.querySelector("details");
        if (dd) dd.open = false;
        if (document.activeElement) document.activeElement.blur();
        setTimeout(loadRithmic, 2500);
      }
    };
  } catch (e) { body.innerHTML = `<span class="muted small">status unavailable: ${esc(e.message)}</span>`; }
}

/* ---------- live alert toasts ---------- */
function showToast(a) {
  const stack = $("#toast-stack");
  const t = document.createElement("div");
  t.className = "toast " + esc(a.kind || "");
  t.innerHTML = `<b>${a.kind === "rate-repricing" ? "⚡ Rates" : a.kind === "headline" ? "🚨 Headline" : "🔮 Repricing"}</b>
    <span>${esc(a.text)}</span><button class="t-x">✕</button>`;
  t.querySelector(".t-x").onclick = () => t.remove();
  stack.appendChild(t);
  setTimeout(() => t.remove(), 25000);
}

async function pollAlerts() {
  try {
    const d = await api("/alerts");
    if (!d.ok) return;
    const seen = new Set(JSON.parse(localStorage.getItem("edgedesk.alerts.seen") || "[]"));
    (d.alerts || []).forEach(a => {
      if (!a.id || seen.has(a.id)) return;
      seen.add(a.id);
      showToast(a);
    });
    localStorage.setItem("edgedesk.alerts.seen", JSON.stringify([...seen].slice(-300)));
  } catch (e) { /* best effort */ }
}

/* ---------- boot ---------- */
$$("#macro-seg button").forEach(b => b.onclick = () => {
  $$("#macro-seg button").forEach(x => x.classList.toggle("active", x === b));
  state.macroSub = b.dataset.sub;
  loadMacro();
});

document.addEventListener("click", ev => {
  const pop = $("#popover");
  const btn = ev.target.closest("button.info");
  if (btn && btn.dataset.info) {
    const r = btn.getBoundingClientRect();
    pop.textContent = btn.dataset.info;
    pop.style.display = "block";
    const pw = Math.min(340, window.innerWidth - 24);
    pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - pw - 12)) + "px";
    pop.style.top = (r.bottom + 8) + "px";
    ev.stopPropagation();
  } else if (pop.style.display === "block") {
    pop.style.display = "none";
  }
});

initShell();
loadTab("briefing");
pollAlerts();
// idle prefetch: warm the other desks right after first paint so tab switches feel instant
setTimeout(() => {
  ["/board", "/news", "/calendar?days=13&country=USD", `/patterns/${state.symbol}`,
   `/profile-advanced/${state.symbol}?days=10&session=rth&va=70&tpr=0`]
    .forEach(p => api(p).catch(() => {}));
}, 3500);
setInterval(pollAlerts, 30000);
setInterval(() => { if (state.tab === "board") { loadBoard(); } }, 15000);
setInterval(() => { if (state.tab === "trade") pollDom(); }, 1500);
setInterval(() => { if (state.tab === "trade") loadPaperDash(); }, 12000);
setInterval(() => { if (state.tab === "news") loadNews(true); }, 45000);
