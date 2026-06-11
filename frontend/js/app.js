/* EdgeDesk frontend — vanilla JS, no build step. */
"use strict";

const SYMBOLS = ["ES","NQ","YM","RTY","CL","NG","GC","SI","HG","ZB","ZN","ZF","6E","6J","BTC"];
const state = { symbol: localStorage.getItem("edgedesk.symbol") || "ES", tab: "briefing",
                chart: null, series: null, interval: "5m", period: "5d", loaded: {} };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-US", {maximumFractionDigits: d, minimumFractionDigits: 0});
const cls = n => n > 0 ? "up" : n < 0 ? "down" : "flat";
const sign = n => n > 0 ? "+" : "";

async function api(path) {
  const r = await fetch("/api" + path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

/* ---------- shell ---------- */
function initShell() {
  const sel = $("#symbol-select");
  sel.innerHTML = SYMBOLS.map(s => `<option ${s === state.symbol ? "selected" : ""}>${s}</option>`).join("");
  sel.onchange = () => {
    state.symbol = sel.value;
    localStorage.setItem("edgedesk.symbol", state.symbol);
    state.loaded = {};            // symbol-scoped tabs must refetch
    loadTab(state.tab, true);
  };
  $$("#tabs button").forEach(b => b.onclick = () => {
    $$("#tabs button").forEach(x => x.classList.toggle("active", x === b));
    $$(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
    state.tab = b.dataset.tab;
    loadTab(state.tab);
  });
  setInterval(() => {
    const et = new Date().toLocaleString("en-US", {timeZone: "America/New_York", hour12: false,
      weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit"});
    $("#clock").textContent = et + " ET";
  }, 1000);
}

function loadTab(tab, force = false) {
  const symScoped = ["briefing", "board", "profile", "flow"];
  const key = symScoped.includes(tab) ? `${tab}:${state.symbol}` : tab;
  if (!force && state.loaded[key]) return;
  state.loaded[key] = true;
  ({briefing: loadBriefing, board: loadBoard, profile: loadProfile, calendar: loadCalendar,
    news: loadNews, cb: loadCB, flow: loadFlow, playbooks: loadPlaybooks, journal: loadJournal}[tab])();
}

/* ---------- briefing ---------- */
async function loadBriefing() {
  const el = $("#tab-briefing");
  el.innerHTML = `<div class="loading">Generating pre-market briefing for ${state.symbol}…</div>`;
  try {
    const b = await api(`/briefing?symbol=${state.symbol}`);
    const q = b.quote || {};
    const warn = (b.session_warnings || []).map(w =>
      `<div class="brief-warning ${/CRITICAL/.test(w) ? "crit" : ""}">${esc(w)}</div>`).join("") ||
      `<div class="muted small">No special session warnings.</div>`;
    const oc = b.opening_context;
    const lv = (b.key_levels || []).map(l => `
      <tr><td>${esc(l.name)}</td><td class="num">${fmt(l.price, 4)}</td>
      <td class="num ${cls(-l.distance)}">${sign(-l.distance)}${fmt(-l.distance, 2)}</td>
      <td><span class="badge ${l.fresh ? "fresh" : "tested"}">${l.fresh ? "first touch" : `tested ×${l.touches_2d}`}</span></td>
      <td class="muted small">${esc(l.note || "")}</td></tr>`).join("");
    const setups = (b.suggested_setups || []).map(s =>
      `<li><b>${esc(s.id)}</b> — ${esc(s.reason)} <span class="muted small">(see Playbooks tab)</span></li>`).join("");
    const rates = (b.rates.implied_path || []).filter(m => m.ok).map(m =>
      `<li>${esc(m.meeting)} (${m.days_until}d): implied ${fmt(m.implied_post_rate, 2)}% ` +
      `(${sign(m.implied_change_bp)}${fmt(m.implied_change_bp, 0)}bp) — ` +
      m.scenarios.map(s => `${s.move_bp}bp: ${s.prob}%`).join(" / ") + `</li>`).join("");
    const g = b.gamma || {};
    el.innerHTML = `
      <div class="panel"><div class="panel-title">Session Warnings — ${esc(b.symbol)}
        <small>${esc(b.generated)} · last ${fmt(q.last, 2)} (${sign(q.change_pct)}${fmt(q.change_pct, 2)}%)</small></div>${warn}</div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Opening Context <small>Day 8 decision tree</small></div>
          ${oc ? `<p><b>${esc(oc.zone)}</b> <span class="muted small">(ref: ${fmt(oc.reference, 2)} — ${esc(oc.reference_source)})</span></p>
          <p class="mt8">${esc(oc.bias)}</p>
          ${oc.overnight_note ? `<p class="mt8" style="color:var(--amber)">${esc(oc.overnight_note)}</p>` : ""}
          <p class="mt8 muted small">${esc(oc.first_hour_rule)}</p>
          ${b.prior_day_type ? `<p class="mt12"><b>Prior day type:</b> ${esc(b.prior_day_type.type)} <span class="muted small">${esc(b.prior_day_type.note)}</span></p>` : ""}`
          : `<div class="err">${esc(b.levels_error || "levels unavailable")}</div>`}</div>
        <div class="panel"><div class="panel-title">Today &amp; What's Priced In</div>
          ${(b.today_events || []).length ? `<ul class="clean">${b.today_events.map(e =>
            `<li><span class="badge ${e.impact}">${e.impact}</span> <b>${esc(e.event)}</b> ${esc(e.time)}${e.approx ? " <span class='muted'>~</span>" : ""}</li>`).join("")}</ul>`
            : `<p class="muted small">No tier-1 releases today.</p>`}
          ${b.next_major_event ? `<p class="mt8 small">Next major: <b>${esc(b.next_major_event.event)}</b> ${esc(b.next_major_event.date)} (${b.next_major_event.days_until}d)</p>` : ""}
          <div class="mt12"><b>Fed path (ZQ-implied)</b>${rates ? `<ul class="clean small">${rates}</ul>` : `<p class="muted small">ZQ contracts unavailable right now.</p>`}</div>
          <div class="mt12"><b>Dealer gamma:</b> ${g.ok ? `<span class="${g.regime === "positive" ? "gex-pos" : "gex-neg"}">${esc(g.regime)}</span>
            <span class="muted small"> flip ≈ ${fmt(g.zero_gamma, 0)} · max pain ${fmt(g.max_pain_front, 0)} (proxy) · P/C ${fmt(g.put_call_oi_ratio, 2)}</span>
            <p class="small mt8">${esc(g.read)}</p>` : `<span class="muted small">${esc(g.error || "unavailable")}</span>`}</div></div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Key Levels <small>marked before the open — Day 2</small></div>
          <table><tr><th>Level</th><th>Price</th><th>Away</th><th>Freshness</th><th></th></tr>${lv || "<tr><td colspan=5 class='muted'>—</td></tr>"}</table></div>
        <div class="panel"><div class="panel-title">Suggested Setups for This Context</div>
          ${setups ? `<ul class="clean">${setups}</ul>` : `<p class="muted small">No strong contextual match — that is information too (Day 1: when uncertain, don't force).</p>`}
          <div class="mt12"><b>Pre-open checklist</b><ul class="clean small">${(b.checklist || []).map(c => `<li>${esc(c)}</li>`).join("")}</ul></div></div>
      </div>`;
  } catch (e) { el.innerHTML = `<div class="err">Briefing failed: ${esc(e.message)}</div>`; }
}

/* ---------- board ---------- */
async function loadBoard() {
  renderChart();
  loadRelVol();
  try {
    const b = await api("/board");
    const card = q => `
      <div class="qcard ${q.symbol === state.symbol ? "selected" : ""}" data-sym="${esc(q.symbol)}">
        <div class="sym"><span>${esc(q.symbol)}</span><span>${esc(q.name)}</span></div>
        <div class="px">${q.ok ? fmt(q.last, 4) : "—"}</div>
        <div class="chg ${cls(q.change)}">${q.ok ? `${sign(q.change)}${fmt(q.change, 4)} (${sign(q.change_pct)}${fmt(q.change_pct, 2)}%)` : "no data"}</div>
      </div>`;
    $("#board-grid").innerHTML = b.futures.map(card).join("") +
      `<div style="grid-column:1/-1" class="muted small">Context tape</div>` + b.context.map(card).join("");
    $$("#board-grid .qcard").forEach(c => c.onclick = () => {
      const s = c.dataset.sym;
      if (SYMBOLS.includes(s)) { $("#symbol-select").value = s; $("#symbol-select").onchange(); }
    });
  } catch (e) { $("#board-grid").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
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
  if (typeof LightweightCharts === "undefined") { el.innerHTML = "<div class='err'>chart library failed to load (offline?)</div>"; return; }
  if (!state.chart) {
    state.chart = LightweightCharts.createChart(el, {
      layout: {background: {color: "#151c25"}, textColor: "#7f93a8"},
      grid: {vertLines: {color: "#1c2632"}, horzLines: {color: "#1c2632"}},
      timeScale: {timeVisible: true, secondsVisible: false},
    });
    state.series = state.chart.addCandlestickSeries({
      upColor: "#2ecc71", downColor: "#ff5252", wickUpColor: "#2ecc71", wickDownColor: "#ff5252", borderVisible: false,
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
      const ha = d.avg[i] / max * 110, ht = d.today[i] / max * 110;
      ctx.fillStyle = "#2c4258"; ctx.fillRect(i * w + 1, 120 - ha, w * 0.45, ha);
      ctx.fillStyle = d.today[i] > d.avg[i] ? "#2ecc71" : "#7f93a8";
      ctx.fillRect(i * w + w * 0.5, 120 - ht, w * 0.45, ht);
      if (i % Math.ceil(n / 14) === 0) { ctx.fillStyle = "#5a6c7e"; ctx.font = "10px monospace"; ctx.fillText(s, i * w, 134); }
    });
  } catch (e) {
    ctx.fillStyle = "#7f93a8"; ctx.font = "12px monospace"; ctx.fillText("relative volume unavailable: " + e.message, 10, 60);
  }
}

/* ---------- profile ---------- */
async function loadProfile(day) {
  const el = $("#tab-profile");
  el.innerHTML = `<div class="loading">Building market profile for ${state.symbol}…</div>`;
  try {
    const d = await api(`/profile/${state.symbol}${day ? `?day=${day}` : ""}`);
    if (!d.ok) throw new Error(d.error);
    const t = d.tpo;
    const daySel = `<select id="profile-day">${d.available_days.map(x =>
      `<option ${x === d.day ? "selected" : ""}>${x}</option>`).join("")}</select>`;
    const tpoRows = t.rows.map(r => {
      const isPoc = r.price === t.poc, inVa = r.price <= t.vah && r.price >= t.val;
      return `<div class="tpo-row ${isPoc ? "poc" : ""} ${inVa ? "va" : ""}">
        <span class="p">${fmt(r.price, 4)}${isPoc ? " ◀POC" : r.price === t.vah ? " ◀VAH" : r.price === t.val ? " ◀VAL" : ""}</span>
        <span class="l">${esc(r.letters)}</span></div>`;
    }).join("");
    const vp = d.volume_profile;
    let vpHtml = `<div class="err">${esc(vp.error || "")}</div>`;
    if (vp.ok) {
      const max = Math.max(...vp.levels.map(l => l.volume), 1);
      vpHtml = [...vp.levels].reverse().map(l => {
        const k = l.price === vp.vpoc ? "vpoc" : vp.hvn.includes(l.price) ? "hvn" : vp.lvn.includes(l.price) ? "lvn" : "";
        return `<div class="vp-row ${k}"><span class="p">${fmt(l.price, 4)}</span>
          <div class="bar" style="width:${Math.max(1, l.volume / max * 100)}%"></div></div>`;
      }).join("");
    }
    const fa = t.failed_auction;
    el.innerHTML = `
      <div class="panel"><div class="panel-title">Session ${daySel} — ${esc(state.symbol)}
        <small>O ${fmt(t.open,2)} · H ${fmt(t.high,2)} · L ${fmt(t.low,2)} · C ${fmt(t.close,2)} · IB ${fmt(t.ib_low,2)}–${fmt(t.ib_high,2)}</small></div>
        <p><b>Day type: ${esc(t.day_type.type)}</b> <span class="muted small">(IB ${fmt(t.day_type.ib_pct_of_range*100,0)}% of range, close at ${fmt(t.day_type.close_location*100,0)}%)</span></p>
        <p class="mt8 small">${esc(t.day_type.note)}</p>
        ${t.poor_high ? `<p class="mt8 small" style="color:var(--amber)">⚑ Poor high at ${fmt(t.high,2)} — unfinished auction, magnet above (Day 7).</p>` : ""}
        ${t.poor_low ? `<p class="mt8 small" style="color:var(--amber)">⚑ Poor low at ${fmt(t.low,2)} — unfinished auction, magnet below (Day 7).</p>` : ""}
        ${fa ? `<p class="mt8 small" style="color:var(--purple)">⚑ ${esc(fa.note)}</p>` : ""}
        ${t.single_prints.length ? `<p class="mt8 muted small">Single prints: ${t.single_prints.map(p => fmt(p, 2)).join(", ")} — acceleration zones if revisited.</p>` : ""}</div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">TPO / Market Profile <small>amber = POC · blue prices = value area</small></div>
          <div class="tpo-wrap">${tpoRows}</div></div>
        <div class="panel"><div class="panel-title">Volume Profile <small>${vp.ok ? `VPOC ${fmt(vp.vpoc,2)} · VA ${fmt(vp.val,2)}–${fmt(vp.vah,2)}` : ""}</small></div>
          ${vpHtml}${vp.ok ? `<p class="mt8 muted small">${esc(vp.note)}</p>
          <p class="mt8 small">HVN: ${vp.hvn.map(p=>fmt(p,2)).join(", ") || "—"}<br>LVN: ${vp.lvn.map(p=>fmt(p,2)).join(", ") || "—"}</p>` : ""}</div>
      </div>
      ${d.prior_tpo ? `<div class="panel"><div class="panel-title">Prior Session (${esc(d.prior_day)}) reference</div>
        <p class="small num">POC ${fmt(d.prior_tpo.poc,2)} · VAH ${fmt(d.prior_tpo.vah,2)} · VAL ${fmt(d.prior_tpo.val,2)} · H ${fmt(d.prior_tpo.high,2)} · L ${fmt(d.prior_tpo.low,2)} — day type: ${esc(d.prior_tpo.day_type.type)}</p></div>` : ""}`;
    $("#profile-day").onchange = e => loadProfile(e.target.value);
  } catch (e) { el.innerHTML = `<div class="err">Profile failed: ${esc(e.message)} — Yahoo intraday data needed.</div>`; }
}

/* ---------- calendar ---------- */
async function loadCalendar() {
  const el = $("#tab-calendar");
  try {
    const d = await api("/calendar?days=28");
    const rows = d.events.map(e => `
      <tr><td class="num">${esc(e.date)}${e.approx ? " <span class='muted'>~</span>" : ""}</td>
      <td class="num">${e.days_until === 0 ? "<b style='color:var(--amber)'>TODAY</b>" : e.days_until + "d"}</td>
      <td><b>${esc(e.event)}</b></td><td class="num muted">${esc(e.time)}</td>
      <td><span class="badge ${e.impact}">${e.impact}</span></td>
      <td>${e.playbook.length ? `<button class="danger-link" style="color:var(--blue)" data-pb="${esc(e.event)}">playbook ▾</button>` : ""}</td></tr>
      <tr class="pb-row" data-for="${esc(e.event)}" style="display:none"><td colspan="6">
        <ul class="clean small">${e.playbook.map(p => `<li>${esc(p)}</li>`).join("")}</ul></td></tr>`).join("");
    el.innerHTML = `
      ${d.next_major ? `<div class="panel" style="border-color:var(--amber)"><div class="panel-title">⏳ Next Major Event</div>
        <p><b>${esc(d.next_major.event)}</b> — ${esc(d.next_major.date)} ${esc(d.next_major.time)} (${d.next_major.days_until} days)</p>
        <ul class="clean small mt8">${d.next_major.playbook.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      <div class="panel"><div class="panel-title">Scheduled-News War Calendar <small>next 28 days</small></div>
        <table><tr><th>Date</th><th>In</th><th>Event</th><th>Time</th><th>Impact</th><th></th></tr>${rows}</table>
        <p class="mt8 muted small">${esc(d.disclaimer)}</p></div>`;
    $$("button[data-pb]", el).forEach(b => b.onclick = () => {
      const row = $(`.pb-row[data-for="${CSS.escape(b.dataset.pb)}"]`, el);
      const all = $$(`.pb-row[data-for="${CSS.escape(b.dataset.pb)}"]`, el);
      const target = b.closest("tr").nextElementSibling;
      target.style.display = target.style.display === "none" ? "" : "none";
    });
  } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
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
        <div class="panel"><div class="panel-title">🚨 Severity Alerts <small>crisis / geopolitics / policy shocks</small></div>
          ${alerts || `<p class="muted small">No high-severity headlines on the wires.</p>`}
          <div class="mt12"><b>Unscheduled-news playbook</b>
          <ul class="clean small">${d.playbook.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div></div>
        <div class="panel"><div class="panel-title">Live Wire <small>auto-refreshes every 2 min · severity-scored</small></div>
          <div style="max-height:640px;overflow-y:auto">${items || "<p class='muted'>no items</p>"}</div>
          ${(d.errors||[]).length ? `<p class="mt8 muted small">Feeds unreachable: ${d.errors.map(x => esc(x.source)).join(", ")}</p>` : ""}</div>
      </div>`;
  } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---------- central banks ---------- */
async function loadCB() {
  const el = $("#tab-cb");
  el.innerHTML = `<div class="loading">Reading rate markets…</div>`;
  try {
    const [d, corr] = await Promise.all([api("/central-banks"), api("/correlations")]);
    const fw = d.fedwatch;
    const meetings = (fw.meetings || []).map(m => m.ok ? `
      <tr><td class="num">${esc(m.meeting)}</td><td class="num">${m.days_until}d</td>
      <td class="num">${fmt(m.implied_post_rate, 2)}%</td>
      <td class="num ${cls(m.implied_change_bp)}">${sign(m.implied_change_bp)}${fmt(m.implied_change_bp, 0)}bp</td>
      <td class="num">${m.scenarios.map(s => `${s.move_bp >= 0 ? "+" : ""}${s.move_bp}bp: <b>${s.prob}%</b>`).join(" · ")}</td></tr>`
      : `<tr><td class="num">${esc(m.meeting)}</td><td class="num">${m.days_until}d</td><td colspan="3" class="muted small">${esc(m.error)}</td></tr>`).join("");
    const yc = d.yield_curve;
    const ycHtml = yc.ok ? yc.points.map(p =>
      `<span class="num" style="margin-right:18px"><b>${esc(p.tenor)}</b> ${fmt(p.yield, 2)}% <span class="${cls(p.chg_bp)}">${sign(p.chg_bp)}${fmt(p.chg_bp, 1)}bp</span></span>`).join("")
      + (yc.spread_3m10y_bp != null ? `<p class="mt8 small">3M/10Y spread: <b class="${cls(yc.spread_3m10y_bp)}">${fmt(yc.spread_3m10y_bp, 0)}bp</b>${yc.spread_3m10y_bp < 0 ? " (inverted)" : ""}</p>` : "")
      : `<span class="muted small">yield data unavailable</span>`;
    let corrHtml = `<div class="err">${esc(corr.error || "")}</div>`;
    if (corr.ok) {
      const color = v => v == null ? "#1d2733" : v > 0 ? `rgba(46,204,113,${Math.abs(v) * 0.75})` : `rgba(255,82,82,${Math.abs(v) * 0.75})`;
      corrHtml = `<table><tr><th></th>${corr.symbols.map(s => `<th class="num">${esc(s)}</th>`).join("")}</tr>` +
        corr.symbols.map((s, i) => `<tr><th class="num">${esc(s)}</th>` +
          corr.matrix[i].map(v => `<td class="corr-cell" style="background:${color(v)}">${v == null ? "—" : v.toFixed(2)}</td>`).join("") + "</tr>").join("") + "</table>";
      if (corr.regime_shifts.length) corrHtml += `<div class="mt12"><b>⚠ Regime shifts (vs prior ${corr.window}d window)</b><ul class="clean small">` +
        corr.regime_shifts.map(r => `<li><b>${esc(r.pair)}</b>: ${r.before.toFixed(2)} → ${r.now.toFixed(2)}</li>`).join("") + `</ul></div>`;
      corrHtml += `<p class="mt8 muted small">${esc(corr.note)}</p>`;
    }
    el.innerHTML = `
      <div class="panel"><div class="panel-title">FedWatch — Implied Rate Path <small>${esc(fw.method || "")}</small></div>
        <p class="small">Current implied rate: <b class="num">${fmt(fw.current_implied_rate, 2)}%</b></p>
        <table class="mt8"><tr><th>Meeting</th><th>In</th><th>Implied post-rate</th><th>Change</th><th>Probabilities</th></tr>${meetings}</table>
        <ul class="clean small mt12">${(fw.playbook || []).map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Yield Curve</div>${ycHtml}
          <div class="mt12"><b>Other Central Banks</b><table class="mt8"><tr><th>Bank</th><th>Cadence</th><th>What to watch</th></tr>
          ${d.other_banks.map(b => `<tr><td><b>${esc(b.bank)}</b></td><td class="small">${esc(b.cadence)}</td><td class="small">${esc(b.watch)}</td></tr>`).join("")}</table></div></div>
        <div class="panel"><div class="panel-title">${esc(d.prep_process.title)}</div>
          <ul class="clean">${d.prep_process.items.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div>
      </div>
      <div class="panel"><div class="panel-title">Cross-Asset Correlations <small>rolling ${corr.window || 20}d, daily returns</small></div>${corrHtml}</div>`;
  } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---------- flow ---------- */
async function loadFlow() {
  const el = $("#tab-flow");
  el.innerHTML = `<div class="loading">Computing dealer gamma for ${state.symbol}… (option chains take ~10s)</div>`;
  try {
    const d = await api(`/flow?symbol=${state.symbol}`);
    const g = d.gex;
    let gexHtml;
    if (g.ok) {
      const maxAbs = Math.max(...g.strikes.map(s => Math.abs(s.net_gex)), 1);
      const rows = g.strikes.filter(s => Math.abs(s.net_gex) > maxAbs * 0.02).map(s => {
        const w = Math.abs(s.net_gex) / maxAbs * 50;
        const pos = s.net_gex >= 0;
        return `<div class="vp-row"><span class="p">${fmt(s.strike, 1)}</span>
          <div style="width:50%;display:flex;justify-content:flex-end">${!pos ? `<div class="bar" style="width:${w * 2}%;background:#a83a4e"></div>` : ""}</div>
          <div style="width:50%">${pos ? `<div class="bar" style="width:${w * 2}%;background:#2e8b57"></div>` : ""}</div></div>`;
      }).join("");
      gexHtml = `
        <p><b>Regime: <span class="${g.regime === "positive" ? "gex-pos" : "gex-neg"}">${esc(g.regime)} gamma</span></b>
        <span class="muted small">· proxy ${esc(g.proxy)} spot ${fmt(g.spot, 2)} · zero-gamma flip ≈ <b>${fmt(g.zero_gamma, 0)}</b> ·
        max pain (front) ${fmt(g.max_pain_front, 0)} · put/call OI ${fmt(g.put_call_oi_ratio, 2)}</span></p>
        <p class="mt8 small">${esc(g.read)}</p>
        <div class="mt12 small muted">Net GEX by strike (red = put-dominated / negative, green = call-dominated / positive)</div>
        <div class="mt8">${rows}</div>
        <p class="mt8 muted small">Computed from free ${esc(g.proxy)} option chains (expirations: ${g.expiries_used.slice(0,4).map(esc).join(", ")}…). Translate proxy strikes to futures levels proportionally.</p>`;
    } else {
      gexHtml = `<div class="err">GEX unavailable: ${esc(g.error)}${["ES","NQ","RTY"].includes(state.symbol) ? "" : " — GEX is computed for index futures (ES/NQ/RTY) via their ETF proxies."}</div>`;
    }
    el.innerHTML = `
      <div class="panel"><div class="panel-title">Dealer Gamma Exposure — ${esc(state.symbol)}</div>${gexHtml}</div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">Expiration / Flow Calendar</div>
          <table><tr><th>Date</th><th>In</th><th>Event</th><th>Impact</th><th></th></tr>
          ${d.expirations.map(e => `<tr><td class="num">${esc(e.date)}</td><td class="num">${e.days_until}d</td>
            <td><b>${esc(e.event)}</b></td><td><span class="badge ${e.impact}">${e.impact}</span></td>
            <td class="muted small">${esc(e.note)}</td></tr>`).join("")}</table></div>
        <div class="panel"><div class="panel-title">Flow Playbook</div>
          <ul class="clean">${d.playbook.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>
      </div>`;
  } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---------- playbooks ---------- */
async function loadPlaybooks() {
  const el = $("#tab-playbooks");
  try {
    const d = await api("/playbooks");
    el.innerHTML = `
      <div class="panel"><div class="panel-title">Setup Library <small>each card maps to program principles — tag journal trades with these ids</small></div>
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
  } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---------- journal ---------- */
async function loadJournal() {
  const el = $("#tab-journal");
  try {
    const [m, t, pb] = await Promise.all([api("/journal/metrics"), api("/journal/trades"), api("/playbooks")]);
    const setupOpts = pb.setups.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    const kpis = m.count ? `
      <div class="kpi-row">
        <div class="kpi"><div class="v ${cls(m.net_pnl)}">$${fmt(m.net_pnl)}</div><div class="k">Net P&L (${m.count} trades)</div></div>
        <div class="kpi"><div class="v">${fmt(m.expectancy_usd)}</div><div class="k">Expectancy $/trade</div></div>
        <div class="kpi"><div class="v">${fmt(m.profit_factor)}</div><div class="k">Profit factor</div></div>
        <div class="kpi"><div class="v">${fmt(m.win_rate, 1)}%</div><div class="k">Win rate (one input, not the verdict)</div></div>
        <div class="kpi"><div class="v">${fmt(m.avg_r)}</div><div class="k">Avg R</div></div>
        <div class="kpi"><div class="v down">-$${fmt(m.max_drawdown)}</div><div class="k">Max drawdown</div></div>
      </div>` : `<p class="muted small">No trades yet — log your first trade below. Metrics follow the Day 1 rule: combined key metrics, never win rate alone.</p>`;
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
      <td class="small">${[x.planned ? "" : "impulse", x.followed_plan ? "" : "off-plan", x.style_drift ? "drift" : ""].filter(Boolean).join(", ")}</td>
      <td><button class="danger-link" data-del="${x.id}">✕</button></td></tr>`).join("");
    el.innerHTML = `
      ${kpis}
      ${audits ? `<div class="panel"><div class="panel-title">⚠ Principles Audit</div>${audits}</div>` : ""}
      <div class="grid2">
        <div class="panel"><div class="panel-title">Equity Curve</div><canvas id="eq-canvas" height="180"></canvas>
          ${bySetup ? `<div class="mt12"><b>Edge by setup</b>${bySetup}</div>` : ""}</div>
        <div class="panel"><div class="panel-title">Log Trade</div>
          <form class="trade-form" id="trade-form">
            <div><label>Symbol</label><select name="symbol">${SYMBOLS.map(s => `<option ${s === state.symbol ? "selected" : ""}>${s}</option>`).join("")}</select></div>
            <div><label>Direction</label><select name="direction"><option>long</option><option>short</option></select></div>
            <div><label>Setup</label><select name="setup"><option value="">(untagged)</option>${setupOpts}</select></div>
            <div><label>Contracts</label><input name="contracts" type="number" step="1" value="1"></div>
            <div><label>Entry</label><input name="entry" type="number" step="any" required></div>
            <div><label>Stop</label><input name="stop" type="number" step="any"></div>
            <div><label>Target</label><input name="target" type="number" step="any"></div>
            <div><label>Exit</label><input name="exit" type="number" step="any" required></div>
            <div><label>Planned trade?</label><select name="planned"><option value="1">yes</option><option value="0">no (impulse)</option></select></div>
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
  } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function drawEquity(curve) {
  const cv = $("#eq-canvas"); if (!cv) return;
  const ctx = cv.getContext("2d");
  cv.width = cv.clientWidth || 600;
  const W = cv.width, H = cv.height, pad = 8;
  const vals = curve.map(c => c.equity);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = (max - min) || 1;
  const x = i => pad + i / Math.max(curve.length - 1, 1) * (W - 2 * pad);
  const y = v => H - pad - (v - min) / span * (H - 2 * pad);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#3a4a5c"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - pad, y(0)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = vals[vals.length - 1] >= 0 ? "#2ecc71" : "#ff5252"; ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((c, i) => i ? ctx.lineTo(x(i), y(c.equity)) : ctx.moveTo(x(i), y(c.equity)));
  ctx.stroke();
}

/* ---------- boot ---------- */
initShell();
loadTab("briefing");
setInterval(() => { if (state.tab === "board") loadBoard(); }, 30000);
setInterval(() => { if (state.tab === "news") loadNews(); }, 120000);
