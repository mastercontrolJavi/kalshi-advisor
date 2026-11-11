# quant/ — Python research for the KXBTC15M advisor

Read-only on `data/*.db` (opened `mode=ro`, `query_only`), so it is safe while the engine runs. Nothing here places orders
or changes the engine's advice.

```powershell
cd quant
uv sync                      # Python 3.13, polars, numpy, scipy, scikit-learn, LightGBM
uv run python data.py        # build quant/cache/*.parquet (first run ~3 min; --refresh to rebuild)
uv run python research.py    # Part 1: fill post-mortem + feature study  -> output/quant/research.md
uv run python model.py       # Part 2a: walk-forward LightGBM            -> quant/cache/pred_*.parquet
uv run python backtest.py    # Part 2b: fee-aware backtests              -> output/PYTHON-QUANT-REPORT.md
uv run python tape.py --every 4   # optional: trade tape for every 4th journaled round (~45 min, network)
uv run python maker_study.py      # resting-order study on that tape -> output/quant/maker-study.md
uv run python direction.py        # how accurate the UP/DOWN call is, and whether anything adds to it
uv run pytest                # accounting and math checks
```

| File | What it does |
|---|---|
| `data.py` | Loads fills, settlements, rounds, candles, spot, outcomes, BRTI (1 Hz archive + live, 5 Hz) and the 1-s tick journal |
| `features.py` | Per-second feature panel: book imbalance, proxy vs BRTI divergence, exact 60-s lock math, forward labels |
| `research.py` | FIFO lot accounting of your real fills; walk-forward feature screen against Kalshi's own price |
| `model.py` | LightGBM boosted from Kalshi's price, 6 expanding folds by round time, Platt calibration |
| `edge_calibration.py` | Checks the edge sidecar's fair value on the BRTI archive (variance ratio, sd by time left, held-out outcome calibration) and replays its EV gate on real asks with a 1–5 s fill delay -> output/quant/edge-calibration.md |
| `tape.py` | Downloads the public Kalshi trade tape for a sample of journaled rounds into `cache/tape/` (unsigned GETs, resumable; run it while the engine is not trading) |
| `maker_study.py` | Resting orders simulated against that tape: fills by queue position, 10-s and 60-s markouts, model-filtered bids, and rest-first-then-take against taking at once -> output/quant/maker-study.md |
| `direction.py` | Hit rate of the UP/DOWN call by time left against Kalshi's favourite and its own ceiling, the dashboard's recorded calls, and a held-out momentum test -> output/quant/direction.md |
| `backtest.py` | Taker (hold / 60-s scalp), maker (trade-through fills), final-minute lock strategies and the tear sheet |

Two facts the code relies on, both checked against Kalshi's own records:

- On a Kalshi fill, `side` is the contract acquired at that side's price; `action` is only the order type. "sell no @ 54¢"
  is selling YES at 46¢.
- Kalshi settles on the average of BRTI over `[close − 60 s, close)` (983/983 rounds within half a cent). The TypeScript
  engine's `benchmark.ts` uses `(close − 60 s, close]`, one second late.
