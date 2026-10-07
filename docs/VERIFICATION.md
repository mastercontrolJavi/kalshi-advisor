# Verification record — 2026-10-06 (America/Los_Angeles)

## Automated and local integration

- 40 Vitest tests passing; TypeScript checks passing; Next.js 15.5.27 production build passing. `npm audit` reports zero vulnerabilities after patched dependency updates.
- `npm run trade` was launched on Windows. Keep-awake helper reported `Windows keep-awake active` after a successful SetThreadExecutionState call.
- Engine was intentionally terminated at 20:08:27 PDT and restarted by the supervisor at 20:08:29. The new process restored SQLite price history, reconnected all four venues, and served live state. A transient 503 during intentional downtime was observed; the UI recovered through its reconnect loop.
- `node --import tsx scripts/verify-live.ts` passes: unauthenticated pages/assets/API return 401; authenticated pages return 200; market/proxy/loop values available; settings reject absent Origin and accept same-origin validated updates; all five tables export; unauthenticated WS returns 401; authenticated WS sends consecutive updates.
- Browser: Microsoft Edge via Playwright CLI, 390×844 mobile viewport. Dashboard and calibration have document width exactly 390px (no horizontal overflow). Live model/book/WS state rendered, collapsibles and calibration navigation checked. Desktop inspection and additional lifecycle evidence recorded below when completed.

## Observed exchange data

All four venue feeds connected to public WS with actual BTC/USD mids. Public Kalshi REST found active and next KXBTC15M contracts, verified fee metadata, opening strike, fixed-point bids and legal ticks.

First observed market: KXBTC15M-26OCT062300-00 (19:45–20:00 PDT). Engine started partway through the window. It evaluated the model, collected all sixty closing seconds, rolled to the next market, then persisted official YES result. Closing average official 83,852.84 USD; proxy 83,848.62745833336 USD; basis error −4.21254166664 USD. This is partial-window observation, not a full uninterrupted cycle.

The following 20:00–20:15 PDT market was observed at opening; planned build/restart and intentional crash checks occurred during the window. Final close/settlement evidence is added after it completes.

## Not verified / limitations

- No local Kalshi API key ID or PEM was supplied during the build. Authenticated Kalshi WS, account tier/endpoint costs, actual balance/positions/fills/settlements and real-account guardrail reconciliation remain unverified. Unit tests cover signing and normalization; taker signals and sizing remain suppressed without account state. WS orderbook recovery is tested with fixtures, not a live authenticated stream.
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
