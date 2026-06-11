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
  setInterval(updateHeaderQuote, 30000);
  initCountdown();
}

function loadTab(tab, force = false) {
  const symScoped = ["briefing", "board", "profile", "flow"];
  const key = symScoped.includes(tab) ? `${tab}:${state.symbol}` : tab;
  if (!force && state.loaded[key]) return;
  state.loaded[key] = true;
  ({briefing: loadBriefing, board: loadBoard, profile: () => loadProfile(), calendar: loadCalendar,
    news: loadNews, cb: loadCB, flow: loadFlow, playbooks: loadPlaybooks, journal: loadJournal,
    predict: loadPredictions}[tab])();
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
    const cal = await api("/calendar?days=40");
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
          ${ideas || `<p class="muted small">No graded zones near price — wait for the market to come to a mapped area (Day 5: only asymmetric trades).</p>`}
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
  }
  try {
    const d = await api(`/candles/${state.symbol}?period=${state.period}&interval=${state.interval}`);
    if (!d.ok) throw new Error(d.error);
    state.series.setData(d.candles);
    state.chart.timeScale().fitContent();
  } catch (e) { console.warn("chart", e); }
}

async function loadRelVol() {
  const cv = $("#relvol-canvas"), ctx = cv.getContext("2d");
  cv.width = cv.clientWidth || 1200;
  ctx.clearRect(0, 0, cv.width, cv.height);
  try {
    const d = await api(`/relative-volume/${state.symbol}`);
    if (!d.ok) throw new Error(d.error);
    const n = d.slots.length, w = cv.width / n, max = Math.max(...d.avg, ...d.today, 1);
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
  const ctx = cv.getContext("2d");
  cv.width = cv.clientWidth || 300;
  const W = cv.width, H = cv.height, pad = 4;
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
  const el = $("#tab-predict");
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
       Tighten structure or skip — never widen risk to fit a trade (Day 5).</span>`
    : `<div class="big">${contracts} contract${contracts > 1 ? "s" : ""} ${dir}</div>
       <table class="small">
       <tr><td class="muted">Stop distance</td><td class="num">${fmt(stopTicks, 0)} ticks ($${fmt(riskPerCt)}/ct)</td></tr>
       <tr><td class="muted">Total risk</td><td class="num">$${fmt(contracts * riskPerCt)} of $${fmt(budget)} budget</td></tr>
       <tr><td class="muted">+1R target</td><td class="num">${fmt(tgt(1), 4)}</td></tr>
       <tr><td class="muted">+2R target</td><td class="num up">${fmt(tgt(2), 4)}</td></tr>
       <tr><td class="muted">+3R target</td><td class="num up">${fmt(tgt(3), 4)}</td></tr></table>
       <div class="muted small mt8">Only take it if the realistic target beats the stop distance — asymmetry or pass (Day 5).</div>`;
}

/* ---------- profile workbench ---------- */
const WB_COLORS = { bar: "#2c4258", va: "#3d7ab5", poc: "#fbbf24", single: "#a78bfa",
                    ib: "#a78bfa", naked: "#fbbf24", grid: "#16202f", text: "#56708c" };

function wbState() {
  if (!state.wb) state.wb = { days: 10, session: "rth", mode: "tpo", va: 70,
    show: {trail: true, vaBand: true, ib: true, oc: true, singles: true, naked: true},
    typeFilter: "", data: null };
  return state.wb;
}

async function loadProfile() {
  const el = $("#tab-profile");
  const wb = wbState();
  el.innerHTML = `
    <div class="panel">
      <div class="panel-title">🔬 Market Profile Workbench — <span class="accent">${esc(state.symbol)}</span>
        <small>side-by-side sessions on one shared price axis · hover for detail · click a column for TPO letters</small></div>
      <div class="wb-controls">
        <span class="wb-group"><span class="wb-lbl">Days</span><span class="seg" id="wb-days">
          ${[5, 10, 15, 20].map(d => `<button data-v="${d}" ${wb.days === d ? 'class="active"' : ""}>${d}</button>`).join("")}</span></span>
        <span class="wb-group"><span class="wb-lbl">Session</span><span class="seg" id="wb-session">
          <button data-v="rth" ${wb.session === "rth" ? 'class="active"' : ""}>RTH</button>
          <button data-v="eth" ${wb.session === "eth" ? 'class="active"' : ""}>Globex</button>
          <button data-v="all" ${wb.session === "all" ? 'class="active"' : ""}>24h</button></span></span>
        <span class="wb-group"><span class="wb-lbl">Mode</span><span class="seg" id="wb-mode">
          <button data-v="tpo" ${wb.mode === "tpo" ? 'class="active"' : ""}>TPO</button>
          <button data-v="vol" ${wb.mode === "vol" ? 'class="active"' : ""}>Volume</button></span></span>
        <span class="wb-group"><span class="wb-lbl">Value</span><span class="seg" id="wb-va">
          ${[68, 70, 80].map(v => `<button data-v="${v}" ${wb.va === v ? 'class="active"' : ""}>${v}%</button>`).join("")}</span></span>
        <span class="wb-group"><span class="wb-lbl">Overlays</span><span class="seg" id="wb-show">
          ${[["trail", "POC trail"], ["vaBand", "VA band"], ["ib", "IB"], ["oc", "O/C"], ["singles", "Singles"], ["naked", "Naked POC"]]
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
  wire("wb-mode", b => { wb.mode = b.dataset.v; drawWorkbench(); });
  wire("wb-va", b => { wb.va = parseInt(b.dataset.v, 10); fetchWorkbench(); });
  wire("wb-show", b => { wb.show[b.dataset.v] = !wb.show[b.dataset.v]; drawWorkbench(); }, true);
  wire("wb-type", b => { wb.typeFilter = b.dataset.v; drawWorkbench(); renderWbStats(); });
}

async function fetchWorkbench() {
  const wb = wbState();
  const st = $("#wb-status");
  if (st) { st.style.display = ""; st.textContent = `Building ${wb.days} ${wb.session.toUpperCase()} sessions…`; }
  try {
    const d = await api(`/profile-advanced/${state.symbol}?days=${wb.days}&session=${wb.session}&va=${wb.va}`);
    if (!d.ok) throw new Error(d.error || "workbench unavailable");
    wb.data = d;
    if (st) st.style.display = "none";
    drawWorkbench();
    renderWbStats();
    const lg = $("#wb-legend");
    if (lg) lg.innerHTML = `<span class="lg" style="background:${WB_COLORS.bar}"></span> outside value
      <span class="lg" style="background:${WB_COLORS.va}"></span> value area
      <span class="lg" style="background:${WB_COLORS.poc}"></span> POC
      <span class="lg" style="background:${WB_COLORS.single}"></span> single prints / IB
      &nbsp;·&nbsp; ${esc(d.legend.modes)} ${esc(d.legend.naked)}`;
  } catch (e) {
    if (st) { st.style.display = ""; st.innerHTML = errBox("Workbench failed: " + e.message, "Needs intraday history — retry if the free feed is rate-limited."); }
  }
}

function wbVisibleSessions() {
  const wb = wbState();
  if (!wb.data) return [];
  return wb.data.sessions.filter(s => !wb.typeFilter || s.day_type === wb.typeFilter);
}

function drawWorkbench() {
  const wb = wbState();
  const cv = $("#wb-canvas");
  if (!cv || !wb.data) return;
  const d = wb.data;
  const sessions = wbVisibleSessions();
  const ctx = cv.getContext("2d");
  const W = cv.width = cv.clientWidth || 1200;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!sessions.length) {
    ctx.fillStyle = WB_COLORS.text; ctx.font = "13px JetBrains Mono";
    ctx.fillText("no sessions match the day-type filter", 20, 50);
    return;
  }
  const grid = d.grid, n = grid.length, step = d.step;
  const padL = 74, padR = 8, padT = 16, padB = 44;
  const nCols = sessions.length + 1;                       // +1 composite
  const colW = (W - padL - padR) / nCols;
  const yOf = p => padT + (1 - (p - grid[0]) / (grid[n - 1] - grid[0])) * (H - padT - padB);
  const rowH = Math.max(1, (H - padT - padB) / n);

  // price axis + gridlines
  ctx.font = "10px JetBrains Mono"; ctx.fillStyle = WB_COLORS.text;
  const nLabels = 14;
  for (let i = 0; i <= nLabels; i++) {
    const p = grid[0] + (grid[n - 1] - grid[0]) * i / nLabels;
    const y = yOf(p);
    ctx.strokeStyle = WB_COLORS.grid; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(fmt(p, 2), 4, y + 3);
  }
  // last price line
  ctx.strokeStyle = "#38bdf8"; ctx.setLineDash([5, 4]); ctx.beginPath();
  ctx.moveTo(padL, yOf(d.last)); ctx.lineTo(W - padR, yOf(d.last)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#38bdf8"; ctx.fillText(fmt(d.last, 2), W - padR - 56, yOf(d.last) - 4);

  const series = s => wb.mode === "vol" ? s.vol : s.tpo;
  const trail = [];
  sessions.forEach((s, si) => {
    const x0 = padL + si * colW + 3;
    const usable = colW - 10;
    const arr = series(s);
    const maxV = Math.max(...arr, 1);
    // value band
    if (wb.show.vaBand) {
      ctx.fillStyle = "rgba(61,122,181,.10)";
      ctx.fillRect(x0 - 2, yOf(grid[s.vah_i]) - rowH / 2, colW - 6, yOf(grid[s.val_i]) - yOf(grid[s.vah_i]) + rowH);
    }
    for (let i = s.lo_i; i <= s.hi_i; i++) {
      if (!arr[i]) continue;
      const w = Math.max(1.5, arr[i] / maxV * usable);
      const y = yOf(grid[i]);
      ctx.fillStyle = i === s.poc_i ? WB_COLORS.poc
        : (wb.show.singles && s.singles_i.includes(i)) ? WB_COLORS.single
        : (i >= s.val_i && i <= s.vah_i) ? WB_COLORS.va : WB_COLORS.bar;
      ctx.fillRect(x0, y - rowH / 2 + 0.5, w, Math.max(1, rowH - 1));
    }
    // IB bracket
    if (wb.show.ib) {
      ctx.strokeStyle = WB_COLORS.ib; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0 - 2, yOf(s.ib_hi)); ctx.lineTo(x0 - 2, yOf(s.ib_lo)); ctx.stroke();
      ctx.lineWidth = 1;
    }
    // open / close markers
    if (wb.show.oc) {
      ctx.fillStyle = "#34d399";
      ctx.beginPath(); ctx.moveTo(x0 - 1, yOf(s.open)); ctx.lineTo(x0 + 5, yOf(s.open) - 3); ctx.lineTo(x0 + 5, yOf(s.open) + 3); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(x0 + usable - 6, yOf(s.close) - 1, 8, 2);
    }
    // poor extremes flags
    ctx.fillStyle = "#fb5d6c"; ctx.font = "10px JetBrains Mono";
    if (s.poor_high) ctx.fillText("⚑", x0 + usable / 2, yOf(s.high) - 4);
    if (s.poor_low) ctx.fillText("⚑", x0 + usable / 2, yOf(s.low) + 11);
    // naked POC ray
    if (wb.show.naked && s.naked) {
      ctx.strokeStyle = WB_COLORS.naked; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x0, yOf(s.poc_price)); ctx.lineTo(W - padR, yOf(s.poc_price)); ctx.stroke();
      ctx.setLineDash([]);
    }
    trail.push([x0 + usable / 2, yOf(grid[s.poc_i])]);
    // labels
    ctx.fillStyle = WB_COLORS.text; ctx.font = "9.5px JetBrains Mono";
    ctx.fillText(s.day.slice(5), x0, H - padB + 14);
    ctx.fillStyle = s.day_type === "trend" ? "#34d399" : s.day_type.includes("shape") ? "#fbbf24" : WB_COLORS.text;
    ctx.fillText(s.day_type.slice(0, 7), x0, H - padB + 26);
    ctx.fillStyle = s.rf > 0 ? "#34d399" : s.rf < 0 ? "#fb5d6c" : WB_COLORS.text;
    ctx.fillText(`RF${s.rf > 0 ? "+" : ""}${s.rf}`, x0, H - padB + 38);
  });

  // composite column
  const comp = wb.mode === "vol" ? d.composite.vol : d.composite.tpo;
  const x0 = padL + sessions.length * colW + 3;
  const usable = colW - 10;
  const maxC = Math.max(...comp, 1);
  for (let i = 0; i < n; i++) {
    if (!comp[i]) continue;
    ctx.fillStyle = i === d.composite.poc_i ? WB_COLORS.poc
      : (i >= d.composite.val_i && i <= d.composite.vah_i) ? "#7c5cad" : "#4a3a66";
    ctx.fillRect(x0, yOf(grid[i]) - rowH / 2 + 0.5, Math.max(1.5, comp[i] / maxC * usable), Math.max(1, rowH - 1));
  }
  ctx.fillStyle = "#a78bfa"; ctx.font = "9.5px JetBrains Mono";
  ctx.fillText("COMPOSITE", x0, H - padB + 14);
  ctx.fillText(`${sessions.length}d merged`, x0, H - padB + 26);

  // POC trail
  if (wb.show.trail && trail.length > 1) {
    ctx.strokeStyle = "rgba(251,191,36,.55)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    trail.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke(); ctx.lineWidth = 1;
  }

  wireWbHover(cv, {padL, padT, padB, colW, sessions, grid, rowH, yOf});
}

function wireWbHover(cv, geo) {
  const wb = wbState();
  const tip = $("#wb-tip");
  cv.onmousemove = ev => {
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const si = Math.floor((x - geo.padL) / geo.colW);
    if (si < 0 || si >= geo.sessions.length || y < geo.padT || y > cv.height - geo.padB) { tip.style.display = "none"; return; }
    const s = geo.sessions[si];
    const grid = geo.grid;
    const frac = 1 - (y - geo.padT) / (cv.height - geo.padT - geo.padB);
    const price = grid[0] + frac * (grid[grid.length - 1] - grid[0]);
    const i = Math.max(0, Math.min(grid.length - 1, Math.round((price - grid[0]) / (grid[1] - grid[0]))));
    tip.style.display = "block";
    tip.style.left = Math.min(x + 14, r.width - 230) + "px";
    tip.style.top = (y + 10) + "px";
    tip.innerHTML = `<b>${esc(s.day)}</b> · ${esc(s.day_type)}<br>
      price <b class="num">${fmt(grid[i], 4)}</b><br>
      TPO ${s.tpo[i] || 0} · vol ${fmt(s.vol[i] || 0, 0)}<br>
      VA ${fmt(grid[s.val_i], 2)}–${fmt(grid[s.vah_i], 2)} · POC ${fmt(s.poc_price, 2)}${s.naked ? " <span style='color:var(--amber)'>(naked)</span>" : ""}<br>
      RF ${s.rf > 0 ? "+" : ""}${s.rf} · IB ${fmt(s.ib_pct * 100, 0)}% · close@${fmt(s.close_loc * 100, 0)}%`;
  };
  cv.onmouseleave = () => { tip.style.display = "none"; };
  cv.onclick = ev => {
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
    <tr><th>Session</th><th>Type</th><th>Range</th><th>IB%</th><th>RF</th><th>Value width</th><th>Close loc</th><th>Volume</th><th>POC</th><th>Flags</th></tr>
    ${sessions.slice().reverse().map(s => `
      <tr data-day="${esc(s.day)}" style="cursor:pointer">
      <td class="num">${esc(s.day)}</td><td>${esc(s.day_type)}</td>
      <td class="num">${fmt(s.high - s.low, 2)}</td>
      <td class="num">${fmt(s.ib_pct * 100, 0)}%</td>
      <td class="num ${cls(s.rf)}">${s.rf > 0 ? "+" : ""}${s.rf}</td>
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
async function loadCalendar() {
  const el = $("#tab-calendar");
  el.innerHTML = `<div class="loading">Loading calendar…</div>`;
  try {
    const d = await api("/calendar?days=28");
    if (!d.ok) { el.innerHTML = errBox(d.error || "calendar unavailable"); return; }
    const rows = d.events.map((e, i) => `
      <tr><td class="num">${esc(e.date)}${e.approx ? " <span class='muted'>~</span>" : ""}</td>
      <td class="num">${e.days_until === 0 ? "<b style='color:var(--amber)'>TODAY</b>" : e.days_until + "d"}</td>
      <td><b>${esc(e.event)}</b></td><td class="num muted">${esc(e.time)}</td>
      <td><span class="badge ${e.impact}">${e.impact}</span></td>
      <td>${e.playbook.length ? `<button class="link" data-pbrow="${i}">playbook ▾</button>` : ""}</td></tr>
      <tr id="pb-row-${i}" style="display:none"><td colspan="6">
        <ul class="clean small">${e.playbook.map(p => `<li>${esc(p)}</li>`).join("")}</ul></td></tr>`).join("");
    el.innerHTML = `
      ${d.next_major ? `<div class="panel" style="border-color:#6b521e"><div class="panel-title">⏳ Next Major Event</div>
        <p><b class="accent">${esc(d.next_major.event)}</b> — ${esc(d.next_major.date)} ${esc(d.next_major.time)} (${d.next_major.days_until} days)</p>
        <ul class="clean small mt8">${d.next_major.playbook.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      <div class="panel"><div class="panel-title">Scheduled-News War Calendar <small>next 28 days · click playbook for the event-specific plan</small></div>
        <table><tr><th>Date</th><th>In</th><th>Event</th><th>Time</th><th>Impact</th><th></th></tr>${rows}</table>
        <p class="mt8 muted small">${esc(d.disclaimer)}</p></div>`;
    $$("button[data-pbrow]", el).forEach(b => b.onclick = () => {
      const r = $("#pb-row-" + b.dataset.pbrow);
      r.style.display = r.style.display === "none" ? "" : "none";
    });
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- news ---------- */
async function loadNews() {
  const el = $("#tab-news");
  el.innerHTML = `<div class="loading">Scanning wires…</div>`;
  try {
    const d = await api("/news");
    const alerts = (d.alerts || []).map(a => `
      <div class="alert-item"><span class="badge ${a.tier}">${a.tier}</span>
        <a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a>
        <div class="news-meta mt8">${esc(a.source)} · ${a.age_min != null ? a.age_min + "m ago" : ""}
        <span class="impact-chips">${a.impacts.map(i => `<span>${esc(i)}</span>`).join("")}</span></div></div>`).join("");
    const items = (d.latest || []).map(i => `
      <div class="news-item"><span class="badge ${i.tier}">${i.tier}</span>
        <span class="t"><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a></span>
        <span class="impact-chips">${i.impacts.map(x => `<span>${esc(x)}</span>`).join("")}</span>
        <span class="news-meta">${esc(i.source)} · ${i.age_min != null ? i.age_min + "m" : "—"}</span></div>`).join("");
    el.innerHTML = `
      <div class="grid2">
        <div class="panel"><div class="panel-title">🚨 Severity Alerts <small>crises · geopolitics · policy shocks</small></div>
          ${alerts || `<p class="muted small">No high-severity headlines on the wires.</p>`}
          <div class="mt12"><b>Unscheduled-news playbook</b>
          <ul class="clean small">${(d.playbook || []).map(p => `<li>${esc(p)}</li>`).join("")}</ul></div></div>
        <div class="panel"><div class="panel-title">Live Wire <small>auto-refreshes every 2 min · severity-scored · chips = instruments hit</small></div>
          <div style="max-height:640px;overflow-y:auto">${items || `<p class="muted small">${d.ok ? "no items" : esc(d.error || "feeds unreachable")}</p>`}</div>
          ${(d.errors || []).length ? `<p class="mt8 muted small">Feeds unreachable: ${d.errors.map(x => esc(x.source)).join(", ")}</p>` : ""}</div>
      </div>`;
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- central banks ---------- */
async function loadCB() {
  const el = $("#tab-cb");
  el.innerHTML = `<div class="loading">Reading rate markets…</div>`;
  try {
    const [d, corr] = await Promise.all([api("/central-banks"), api("/correlations")]);
    if (!d.fedwatch) { el.innerHTML = errBox(d.error || "central bank data unavailable"); return; }
    const fw = d.fedwatch;
    const meetings = (fw.meetings || []).map(m => m.ok ? `
      <tr><td class="num">${esc(m.meeting)}</td><td class="num">${m.days_until}d</td>
      <td class="num">${fmt(m.implied_post_rate, 2)}%</td>
      <td class="num ${cls(m.implied_change_bp)}">${sign(m.implied_change_bp)}${fmt(m.implied_change_bp, 0)}bp</td>
      <td class="num">${m.scenarios.map(s => `${s.move_bp >= 0 ? "+" : ""}${s.move_bp}bp: <b>${s.prob}%</b>`).join(" · ")}</td></tr>`
      : `<tr><td class="num">${esc(m.meeting)}</td><td class="num">${m.days_until}d</td><td colspan="3" class="muted small">${esc(m.error)}</td></tr>`).join("");
    const yc = d.yield_curve || {};
    const ycHtml = yc.ok ? (yc.points || []).map(p =>
      `<span class="num" style="margin-right:18px"><b>${esc(p.tenor)}</b> ${fmt(p.yield, 2)}% <span class="${cls(p.chg_bp)}">${sign(p.chg_bp)}${fmt(p.chg_bp, 1)}bp</span></span>`).join("")
      + (yc.spread_3m10y_bp != null ? `<p class="mt8 small">3M/10Y spread: <b class="${cls(yc.spread_3m10y_bp)}">${fmt(yc.spread_3m10y_bp, 0)}bp</b>${yc.spread_3m10y_bp < 0 ? " (inverted)" : ""}</p>` : "")
      : `<span class="muted small">yield data unavailable</span>`;
    let corrHtml = errBox(corr.error || "correlations unavailable");
    if (corr.ok) {
      const color = v => v == null ? "#1d2733" : v > 0 ? `rgba(52,211,153,${Math.abs(v) * 0.6})` : `rgba(251,93,108,${Math.abs(v) * 0.6})`;
      corrHtml = `<div style="overflow-x:auto"><table><tr><th></th>${corr.symbols.map(s => `<th class="num">${esc(s)}</th>`).join("")}</tr>` +
        corr.symbols.map((s, i) => `<tr><th class="num">${esc(s)}</th>` +
          corr.matrix[i].map(v => `<td class="corr-cell" style="background:${color(v)}">${v == null ? "—" : v.toFixed(2)}</td>`).join("") + "</tr>").join("") + "</table></div>";
      if ((corr.regime_shifts || []).length) corrHtml += `<div class="mt12"><b>⚠ Regime shifts (vs prior ${corr.window}d window)</b><ul class="clean small">` +
        corr.regime_shifts.map(r => `<li><b>${esc(r.pair)}</b>: ${r.before.toFixed(2)} → ${r.now.toFixed(2)}</li>`).join("") + `</ul></div>`;
      corrHtml += `<p class="mt8 muted small">${esc(corr.note)}</p>`;
    }
    el.innerHTML = `
      <div class="panel"><div class="panel-title">FedWatch — Implied Rate Path <small>${esc(fw.method || "")}</small></div>
        <p class="small">Current implied rate: <b class="num accent">${fmt(fw.current_implied_rate, 2)}%</b></p>
        <table class="mt8"><tr><th>Meeting</th><th>In</th><th>Implied post-rate</th><th>Change</th><th>Probabilities</th></tr>${meetings}</table>
        <ul class="clean small mt12">${(fw.playbook || []).map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Yield Curve</div>${ycHtml}
          <div class="mt12"><b>Other Central Banks</b><table class="mt8"><tr><th>Bank</th><th>Cadence</th><th>What to watch</th></tr>
          ${(d.other_banks || []).map(b => `<tr><td><b>${esc(b.bank)}</b></td><td class="small">${esc(b.cadence)}</td><td class="small">${esc(b.watch)}</td></tr>`).join("")}</table></div></div>
        <div class="panel"><div class="panel-title">${esc((d.prep_process || {}).title || "CB Prep")}</div>
          <ul class="clean">${((d.prep_process || {}).items || []).map(i => `<li>${esc(i)}</li>`).join("")}</ul></div>
      </div>
      <div class="panel"><div class="panel-title">Cross-Asset Correlations <small>rolling ${corr.window || 20}d, daily returns · green +, red −</small></div>${corrHtml}</div>`;
  } catch (e) { el.innerHTML = errBox(e.message); }
}

/* ---------- flow ---------- */
async function loadFlow() {
  const el = $("#tab-flow");
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

/* ---------- playbooks ---------- */
async function loadPlaybooks() {
  const el = $("#tab-playbooks");
  el.innerHTML = `<div class="loading">Loading playbooks…</div>`;
  try {
    const d = await api("/playbooks");
    if (!d.setups) { el.innerHTML = errBox(d.error || "playbooks unavailable"); return; }
    el.innerHTML = `
      <div class="panel"><div class="panel-title">Setup Library <small>tag journal trades with these ids to measure your edge per setup</small></div>
        <div class="grid3">${d.setups.map(s => `
          <div class="setup-card"><span class="dayref">Day ${s.day_ref}</span><h4>${esc(s.name)}</h4>
          <div class="meta"><b>id:</b> <code>${esc(s.id)}</code></div>
          <div class="meta mt8"><b>Context:</b> ${esc(s.context)}</div>
          <div class="meta"><b>Trigger:</b> ${esc(s.trigger)}</div>
          <div class="meta"><b>Entry:</b> ${esc(s.entry)}</div>
          <div class="meta"><b>Stop:</b> ${esc(s.stop)} · <b>Target:</b> ${esc(s.target)}</div>
          <div class="why">Why it works: ${esc(s.why)}</div></div>`).join("")}</div></div>
      <div class="panel"><div class="panel-title">The 14-Day Program — Principles Reference</div>
        <div class="grid2">${d.principles.map(p => `
          <div class="setup-card"><span class="dayref">Day ${p.day}</span><h4>${esc(p.topic)}</h4>
          <ul class="clean small">${p.rules.map(r => `<li>${esc(r)}</li>`).join("")}</ul></div>`).join("")}</div></div>`;
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
  const ctx = cv.getContext("2d");
  cv.width = cv.clientWidth || 600;
  const W = cv.width, H = cv.height, pad = 10;
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

/* ---------- boot ---------- */
initShell();
loadTab("briefing");
setInterval(() => { if (state.tab === "board") { loadBoard(); } }, 30000);
setInterval(() => { if (state.tab === "news") loadNews(); }, 120000);
