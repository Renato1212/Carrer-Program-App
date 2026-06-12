# EdgeDesk — Futures Trading Terminal

A free-data, self-hosted terminal for discretionary futures intraday traders —
a Bloomberg/NewsSquawk-style workflow built on auction-market principles:
market profile & volume analysis, headline news squawk, market sentiment,
scheduled data with real values, and central-bank analysis.

**100% free data.** Yahoo Finance (quotes, intraday history, option chains,
Fed Funds futures), FairEconomy/ForexFactory economic calendar (forecast &
previous values), BLS API (latest actual US prints), CNN Fear & Greed,
alternative.me crypto sentiment, Polymarket & Kalshi prediction markets, and
official central-bank & financial-media RSS wires. No API keys, no
subscriptions, no paid feeds.

---

## Quick start

```bash
pip install -r requirements.txt
uvicorn backend.main:app --port 8000
```

Open **http://localhost:8000** — needs internet access for live data.

---

## The nine desks

| Desk | What it gives you |
|---|---|
| **Game Plan** (landing page) | One organized, actionable plan: a plain-English **Story** of what the market has been doing (value migration, composite location, prior day type, gamma regime, risk schedule), a **Trade Map** that clusters every level from every module — prior/composite value, naked POCs, unfilled gaps, poor extremes, overnight extremes, gamma strikes — into graded confluence zones (A+/A/B/C), concrete **if-rejects / if-accepts trade ideas** at the nearest strong zones with invalidation and next-zone targets, and a Do/Don't list for the day. |
| **Briefing engine** (feeds the Game Plan) | The Day 8 pre-open routine, automated: opening context vs prior value/range (decision tree), gap classification (Day 3), prior day type, auto-marked key levels with first-touch freshness (Day 2), today's events + what's priced in, dealer gamma regime, and setups suggested *for this exact context*. |
| **Live Desk** | Full futures board + context tape (VIX, DXY, yields), candlestick charts, relative volume by 30-min slot (Day 4), a **position sizer** (risk-first contract math with R targets), an in-trade checklist, and an **Order Flow Pulse**: 1-minute delta proxy with cumulative delta, absorption-divergence and volume-burst signals (Days 10–12, free-data approximation). |
| **Profile** | Multi-day first: **5/10/20-day composite volume profile** (cPOC/cVAH/cVAL, HVN/LVN magnets), a **value-migration table** (each session's POC/VA/close/day type + higher/lower/inside relation — the auction's trend at a glance), **unfinished business tracker** (naked POCs, unfilled gaps, untested poor extremes with distances), plus single-session TPO drill-down: POC, value area, Initial Balance, day-type classifier, failed-auction detector. |
| **Calendar** | Scheduled-news war calendar: FOMC (published dates), NFP, CPI, PPI, PCE, ISM, claims, EIA, auctions, OPEX/quad witching — each with an event-specific trading playbook and countdown. |
| **News Radar** | Free RSS aggregation (Fed, ECB, BLS, CNBC, MarketWatch, Yahoo) with tiered severity scoring — crisis/geopolitical shocks float to the top tagged with the instruments they hit, plus the unscheduled-news playbook. |
| **Central Banks** | Implied rate path and hike/cut probabilities backed out of 30-Day Fed Funds futures (ZQ) — the same math as CME FedWatch; yield curve; other-CB watchlist; the Day 14 prep process; rolling cross-asset correlation matrix with regime-shift alerts. |
| **Predictions** | Polymarket + Kalshi free public APIs: macro-relevant markets (Fed, recession, geopolitics, tariffs…) with **24h repricing alerts** — a market swinging ≥8 points often signals positioning changes before headlines hit the wires. Big swings also surface in the morning briefing. |
| **Flow / GEX** | Dealer gamma exposure by strike from free option chains (SPY/QQQ/IWM proxies), zero-gamma flip level, max pain, put/call OI, expiration calendar (weekly/monthly OPEX, quad witching, VIX settle, month-end). |
| **Playbooks** | The whole 14-day program codified: 11 executable setup cards (context / trigger / entry / stop / target / why it works) + every principle, by day. |
| **Journal** | SQLite journal with the Day 1 philosophy built in: expectancy, profit factor, R-distribution, edge-by-setup table, equity curve, max drawdown — and a **principles audit** that flags no-stop trades, style drift, impulse trades, losers held past −1.5R, and inverted win/loss asymmetry. |

## How the program maps to the software

- **Day 1** → journal metrics judged combined, never win rate alone; uncertainty warnings on event days.
- **Day 2** → key-levels engine with first-touch tracking and HTF weighting.
- **Day 3** → gap classifier (just-outside vs far-extended) wired into the opening briefing.
- **Day 4** → relative-volume-by-time curve; breakout conditions in setup cards.
- **Day 5** → asymmetry checks: R-multiples everywhere, style-drift flag.
- **Days 6–9** → TPO/volume profile engines, day types, failed auctions, value migration, poor extremes.
- **Days 10–13** → encoded as order-flow setup cards (absorption pullback, stop-catch, LVN acceleration).
- **Day 14** → the FedWatch engine + central-bank prep checklist + statement-diff workflow.

## Architecture

```
backend/          FastAPI + pandas/numpy/yfinance/httpx
  services/       one module per desk (market_data, profile, levels, fedwatch,
                  econ_calendar, news, flow, correlations, briefing, playbooks, journal)
frontend/         zero-build vanilla JS + lightweight-charts (CDN), dark terminal UI
data/journal.db   created automatically (SQLite)
```

Every service degrades gracefully — if a free source is unreachable you get a
labeled error in that panel, never a crash.

## Honest limitations (free data is free)

- Yahoo intraday: 1m ≈ 7 days back, 30m ≈ 60 days; quotes are slightly delayed.
- GEX uses ETF option proxies (SPY→ES etc.) — translate strikes proportionally.
- Calendar dates marked `~` follow the typical release pattern — verify exact
  dates on bls.gov / bea.gov; FOMC dates are the published schedule.
- No tick/DOM data on free feeds — order-flow principles (Days 10–13) are
  delivered as structured playbooks rather than a live DOM.

## Always-on deployment (recommended): Render

Serverless hosting (Vercel) is fine for a quick look, but it cold-starts
(10-20s first load) and cannot hold live broker sockets. The included
`render.yaml` deploys EdgeDesk to Render's free tier as a persistent process:

1. Go to **https://render.com** → New → Blueprint → connect this repository.
2. Render reads `render.yaml` and deploys automatically. Done.

A persistent instance unlocks: the background warmer (hot endpoints are
precomputed, so pages load instantly), the intraday Fed-repricing monitor,
a journal database that survives, and **Rithmic connections directly from the
web app** — no local install. Note: connect broker credentials only on YOUR
private instance, never on a URL you share publicly.

## Live data: connecting Rithmic (prop-firm accounts)

EdgeDesk runs on free delayed data by default. If you have Rithmic credentials
from a prop firm (Apex Trader Funding, Lucid Trading, Take Profit Trader, or
any Rithmic-based firm), you can stream real-time exchange data into the app:

1. Run EdgeDesk **locally** (live broker sockets cannot run on serverless
   hosting like Vercel):
   ```bash
   pip install -r requirements.txt async_rithmic
   uvicorn backend.main:app --port 8000
   ```
2. Open **Markets → Data Connection**, enter your Rithmic user, password and
   the system name your firm gave you (e.g. `Apex`), and connect.
3. Credentials are stored only in `data/rithmic.json` on your machine
   (gitignored) and are sent nowhere except Rithmic's gateway.

Roadmap opened by this connector: live ticks in the board and order-flow pulse
(phase 1), true tick-based delta / DOM ladder / volume profile from real
prints (phase 2), and order routing with bracket orders sized by the position
sizer (phase 3). The connector uses the community `async_rithmic` library;
exact symbol subscriptions may need adjusting per firm and contract month.

This tool is infrastructure and education, not financial advice.
