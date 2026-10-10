# Verification record — 2026-10-06 (America/Los_Angeles)

## Automated and local integration

- 46 Vitest tests passing; TypeScript checks passing; Next.js 15.5.27 production build passing. `npm audit` reports zero vulnerabilities after patched dependency updates.
- `npm run trade` was launched on Windows. Keep-awake helper reported `Windows keep-awake active` after a successful SetThreadExecutionState call.
- Engine was intentionally terminated at 20:08:27 PDT and restarted by the supervisor at 20:08:29. The new process restored SQLite price history, reconnected all four venues, and served live state. A transient 503 during intentional downtime was observed; the UI recovered through its reconnect loop.
- `node --import tsx scripts/verify-live.ts` passes: unauthenticated pages/assets/API return 401; authenticated pages return 200; market/proxy/loop values available; settings reject absent Origin and accept same-origin validated updates; all five tables export; unauthenticated WS returns 401; authenticated WS sends consecutive updates.
- Browser: Microsoft Edge via Playwright CLI, 390×844 mobile viewport and 1440×1000 desktop. Dashboard and calibration have mobile document width exactly 390px (no horizontal overflow). Live model/book/WS state rendered, collapsibles and calibration navigation checked. Mobile signal/countdown/edge appear first; market details collapse below. Temporary console errors during planned server/build restarts ceased after reload/reconnect.

## Observed exchange data

All four venue feeds connected to public WS with actual BTC/USD mids. Public Kalshi REST found active and next KXBTC15M contracts, verified fee metadata, opening strike, fixed-point bids and legal ticks.

First observed market: KXBTC15M-26OCT062300-00 (19:45–20:00 PDT). Engine started partway through the window. It evaluated the model, collected all sixty closing seconds, rolled to the next market, then persisted official YES result. Closing average official 83,852.84 USD; proxy 83,848.62745833336 USD; basis error −4.21254166664 USD. This is partial-window observation, not a full uninterrupted cycle.

Full lifecycle observed: KXBTC15M-26OCT062315-15, 20:00–20:15 PDT. Opening was observed with tau=900 and K=83,852.84. Model/signal evaluations were journaled through tau=1. SQLite has 834 seconds for this window: 66 earlier seconds were deliberately lost to production build/restart/crash verification, and no fabricated observations were inserted. All sixty final-minute observations are present; locked count advanced through 57, 58, 59 as tau fell through 3, 2, 1. The engine rolled to KXBTC15M-26OCT062330-30 and persisted official YES. Closing average official 83,934.62 USD; proxy 83,929.670375 USD; basis error −4.949625 USD. This confirms open → evaluation → closing average → rollover → official settlement with disclosed restart gaps, not uninterrupted collection.

No actual taker signal or maker paper fill was observed without credentials. Maker ideas were journaled and expired; fixture tests validate trade-through fills, taker fees and settlement profit. The app intentionally suppresses taker recommendations when account state cannot be authenticated.

## Authenticated verification — 2026-10-06 22:00 PDT

- Ed25519 key signed requests accepted by production REST (`/portfolio/balance` 200) and WS. Clock offset to server under 1s.
- Live WS exposed a shared per-sid sequence across markets (see DECISIONS 5) and a REST-fallback race; both fixed with regression tests replaying the recorded message order. After restart: one connect, zero gaps over several minutes.
- Account sync ready: balance, positions, 391 KXBTC15M fills and 65 settlements normalized after fixing sell-direction parsing (DECISIONS 11). Guardrails computed from real fills: 107 trades today, P&L −$9.26 vs first-observed baseline $23.17 → daily loss lock active, which correctly suppresses signals until local midnight.
- `scripts/verify-live.ts` passes all 7 checks with Kalshi WS connected.

## Not verified / limitations

- Realized P&L from fills has not been reconciled line-by-line against Kalshi's own P&L statement. No live taker signal has yet fired with an unlocked account.
- Tailscale is not installed and no tailnet login was supplied. Serve syntax and the free personal plan were verified against current official docs; actual phone HTTPS/WSS login and mobile notification delivery remain unverified.
- macOS caffeinate and Linux systemd-inhibit branches are implemented but untested on this Windows machine. Physical sleep/wake was not forced. Wake detection and reconnect logic are implemented; production engine restart was tested.
- Profitability, execution quality and confidence intervals require a larger independent sample. REST fallback cannot validate live maker trade-through fills. Fixtures cover fill/expiry/settlement behavior. Proxy seconds are never confirmed BRTI seconds.
- The loss baseline for an initial partial day is first observed cash balance; exact historical midnight cash is unavailable without account statements/transfers. The decision and limitation are documented in README and DECISIONS.

## Manual checklist

1. Add key ID and PEM path to .env.local, restart `npm run trade`, and confirm account ready, correct balance, and Kalshi WS connected.
2. Confirm opening K against the Kalshi market and compare YES/NO ask/depth with its website. Check all four feed dots, countdown and fee precision for your account.
3. Verify a suggested contract count does not exceed 25 or 2% of cash including fees; verify NO TRADE reasons respond to stale feeds and guardrails.
4. Observe a closing minute: locked proxy count should advance, market rolls, official outcome appears later in calibration, and CSV contains that market.
5. Open the Tailscale HTTPS URL on the phone, confirm login and live indicator, then check that stopping the engine suppresses advice and restarting reconnects.

## Markets stage 1 — 2026-10-09 (side instance, ports 3010/3012, live account, read-only)

- The markets process synced positions and fills, and polled the held combo and its 8 legs in 2 batched requests.
- State of the combo:
  - 2,777.77 YES at a cost of 0.353¢ per contract incl. fees, from fills ($9.81).
  - Legs: South Alabama won; 7 to play at 42–60¢.
  - Value 0.6154¢ ($17.10). Bid 0.11¢ → sell $2.84 after a $0.21 fee.
  - Verdict HOLD; headline UP +$7.29 (+74%) at leg odds.
- /markets rendered at desktop width and at 375 px. scrollWidth equals 375 on /markets and /hourly with the 5-link nav.
- The category filters set aria-pressed, show the empty state and remember the choice. The combo price line is drawn from #legs snapshots.
- /markets-ws delivered live state through the authenticated web server from the 15-min page.
- next build is green (/markets 4.0 kB); 176 tests pass; tsc is clean.
- The Bitcoin engine loop ran at 5–14 ms with the markets process running. There were no loop-stall events after it started; the last one was at 08:01Z, before any markets run.
- Not verified live:
  - a heads-up firing on a real move (covered by unit tests);
  - sounds playing in the browser (the transition logic is unit-tested);
  - the supervised start under npm run trade (it starts on the next launch from the desktop shortcut).

## Markets stage 2 — 2026-10-09 (Record tab, public backfill)

- First backfill (`npm run markets-backfill -- --reset`, public data, ≤ 5 requests/s): 60 series, 109,161 settled markets since 2026-08-10, all priced, in 1,125 s.
  - Sports: 28,533 markets (9,037 with a price 24 h before, 25,559 at 1 h before).
  - Politics & economics: 13,210 markets (1,922 at 24 h, 1,567 at 1 h).
  - Commodities & crypto: 67,418 markets, mostly 15-minute and strike-ladder markets. Only 1,048 have a 24 h price, so the volume-weighted view covers that category best.
- Bias caught before release:
  - The first run kept the 4,000 most-traded markets per series. That showed sports 5–20¢ returning +31–53% per $1, with ranges above zero.
  - Cause: ranking by total volume keeps longshots that won, because they trade heavily after the horizon.
  - Hash-sampled again, that result vanished. All categories, 24 h before: 0–5¢ returned −61% per $1 (95% range −85% to −32%); 20–35¢ −10% (−17 to −3); 35–50¢ −6% (−11 to −1); 80–90¢ won 2.9 points more often than priced.
- Event timing, measured: MLB/NFL/NHL settle a median 0.2 h after Kalshi's occurrence time, so occurrence ≈ end of game. The labels say "before the result", and 24 h is the default view.
- Your record (real account): 16 settled non-Bitcoin markets, 5 won, −$66.02 (−42% on $157.20 spent).
  - Combos: 0 of 3 won, −$16.33.
  - Commodities & crypto: 1 of 6 won, −$31.77.
  - Sports: 4 of 7 won, −$17.92.
- The /record endpoint reads precomputed tables. Computing them took 2.6 s per 44k markets, so the backfill child does it.
- Browser, side instance on ports 3010/3012:
  - Tabs, category chips and horizon chips work; the combos note and empty states show.
  - 375 px with no horizontal scroll; no console errors.
  - The Positions tab is unchanged apart from the tab bar.
- 198 tests pass, tsc is clean, and next build is green.
