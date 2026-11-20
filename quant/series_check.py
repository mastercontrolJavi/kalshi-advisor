"""Are Kalshi's thinner 15-minute crypto series (ETH, SOL, XRP) wider or slower than KXBTC15M?

    cd quant; uv run python series_check.py [--rounds 96] [--watch 360]   # report -> output/quant/series-check.md

Public, unsigned GETs only (about 2 a second; it shares the network with the engine):
1. the last `--rounds` settled rounds of each series: volume, and the quoted spread at the end of every minute from
   Kalshi's 1-minute candles, by time left and by price;
2. a live watch of each series' open round for `--watch` seconds, one order-book read every 2 s per series: how often
   the best quotes change, the spread, and the size at the best price.

What this cannot show: how fast each book follows its index after an index move. That needs each index at sub-second
resolution next to the book stream, which is recorded only for BTC. Quote changes per minute is the proxy.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from statistics import mean, median

REST = 'https://external-api.kalshi.com/trade-api/v2'
OUT = Path(__file__).resolve().parent.parent / 'output' / 'quant'
SERIES = ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M']
PACE = 0.5


def get(path: str) -> dict:
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(REST + path, headers={'Accept': 'application/json'}), timeout=15) as r:
                time.sleep(PACE)
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError('rate limited')


ts = lambda iso: int(datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp())
f = lambda x: float(x) if x not in (None, '') else None


def history(series: str, rounds: int) -> dict:
    markets, cursor = [], ''
    while len(markets) < rounds:
        d = get(f'/markets?series_ticker={series}&status=settled&limit=100' + (f'&cursor={cursor}' if cursor else ''))
        markets += d.get('markets', [])
        cursor = d.get('cursor') or ''
        if not cursor or not d.get('markets'):
            break
    markets = markets[:rounds]
    rows = []  # (minutes left at the candle's end, yes mid, spread)
    for i in range(0, len(markets), 8):
        group = markets[i:i + 8]
        o, c = min(ts(m['open_time']) for m in group), max(ts(m['close_time']) for m in group)
        d = get(f"/markets/candlesticks?market_tickers={','.join(m['ticker'] for m in group)}&start_ts={o}&end_ts={c}&period_interval=1")
        close = {m['ticker']: ts(m['close_time']) for m in group}
        for mk in d.get('markets', []):
            for cs in mk.get('candlesticks', []):
                bid, ask = f(cs['yes_bid'].get('close_dollars')), f(cs['yes_ask'].get('close_dollars'))
                if bid is None or ask is None or not (0 < bid < ask < 1):
                    continue
                rows.append(((close[mk['market_ticker']] - cs['end_period_ts']) / 60, (bid + ask) / 2, ask - bid))
    vol = [f(m.get('volume_fp')) or 0.0 for m in markets]
    return {'rounds': len(markets), 'volume': vol, 'rows': rows}


def watch(seconds: int) -> dict:
    out = {s: {'n': 0, 'changes': 0, 'spread': [], 'size': [], 'last': None, 'crossings': 0} for s in SERIES}
    tick = {s: None for s in SERIES}
    end = time.time() + seconds
    while time.time() < end:
        for s in SERIES:
            try:
                if tick[s] is None or tick[s][1] < time.time() + 20:
                    ms = get(f'/markets?series_ticker={s}&status=open&limit=2').get('markets', [])
                    ms = [m for m in ms if ts(m['close_time']) > time.time() + 20 and ts(m['open_time']) <= time.time()]
                    tick[s] = (ms[0]['ticker'], ts(ms[0]['close_time'])) if ms else None
                    out[s]['last'] = None
                    if tick[s] is None:
                        continue
                ob = get(f'/markets/{tick[s][0]}/orderbook?depth=3').get('orderbook_fp', {})
                yes, no = ob.get('yes_dollars') or [], ob.get('no_dollars') or []
                if not yes or not no:
                    continue
                yb = max(yes, key=lambda l: float(l[0])); nb = max(no, key=lambda l: float(l[0]))
                bid, ask = float(yb[0]), 1 - float(nb[0])
                if not (0.03 < bid < ask < 0.97):      # the tails are pinned and tell nothing about repricing
                    out[s]['last'] = None
                    continue
                o = out[s]
                o['n'] += 1
                o['spread'].append(ask - bid)
                o['size'].append(min(float(yb[1]), float(nb[1])))
                if o['last'] is not None and o['last'] != (bid, ask):
                    o['changes'] += 1
                o['last'] = (bid, ask)
            except Exception as e:
                print(f'[series_check] {s}: {e!r}', file=sys.stderr)
    return out


def main(argv) -> None:
    rounds = int(argv[argv.index('--rounds') + 1]) if '--rounds' in argv else 96
    secs = int(argv[argv.index('--watch') + 1]) if '--watch' in argv else 360
    md = ['# Thinner 15-minute series against KXBTC15M', '', f'Generated {datetime.now():%Y-%m-%d %H:%M}. Public data only.', '',
          f'## Last {rounds} settled rounds (1-minute candles)', '',
          '| series | rounds | median volume (contracts) | spread, all minutes: median / mean | mid 30-70c: median / mean | 2-10 min left: mean | share of minutes at 1c or less | share at 3c or more |',
          '|---|---:|---:|---:|---:|---:|---:|---:|']
    summary = {}
    for s in SERIES:
        h = history(s, rounds)
        sp = [r[2] for r in h['rows']]
        midband = [r[2] for r in h['rows'] if 0.3 <= r[1] <= 0.7]
        window = [r[2] for r in h['rows'] if 2 <= r[0] <= 10]
        c = lambda xs: f'{100 * median(xs):.1f}c / {100 * mean(xs):.2f}c' if xs else '-'
        summary[s] = {'volume': median(h['volume']) if h['volume'] else 0, 'spread': mean(sp) if sp else None}
        md.append(f"| {s} | {h['rounds']} | {median(h['volume']):,.0f} | {c(sp)} | {c(midband)} | {100 * mean(window):.2f}c | "
                  f"{100 * sum(1 for x in sp if x <= 0.0101) / len(sp):.0f}% | {100 * sum(1 for x in sp if x >= 0.0299) / len(sp):.0f}% |" if sp else f'| {s} | {h["rounds"]} | - | - | - | - | - | - |')
        print(md[-1], file=sys.stderr)
    w = watch(secs)
    md += ['', f'## Live watch, {secs} s, one book read every ~2 s per series (quotes between 3c and 97c only)', '',
           '| series | reads | best quote changed between reads | spread: median / mean | size at the best price, median |', '|---|---:|---:|---:|---:|']
    for s in SERIES:
        o = w[s]
        if o['n'] < 5:
            md.append(f'| {s} | {o["n"]} | - | - | - |')
            continue
        md.append(f"| {s} | {o['n']} | {100 * o['changes'] / max(1, o['n'] - 1):.0f}% | {100 * median(o['spread']):.1f}c / {100 * mean(o['spread']):.2f}c | {median(o['size']):,.0f} |")
        print(md[-1], file=sys.stderr)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'series-check.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main(sys.argv[1:])
