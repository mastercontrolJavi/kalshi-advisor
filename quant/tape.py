"""Kalshi's public trade tape for journaled KXBTC15M rounds, cached one parquet per round under quant/cache/tape/.

    cd quant; uv run python tape.py --every 4        # every 4th journaled round (resumable; ~5 s a round on 8 connections)
    uv run python tape.py --every 1                   # all of them (hours)

Read-only and unsigned: only GET /markets/trades on Kalshi's public REST host, a few connections, about 5 requests a
second in total (Kalshi's basic read limit is ~20 a second), backing off on 429. Nothing is sent but the market ticker and a time range. Run it while the engine is NOT trading: it shares the
connection. Only the trades the study uses are fetched: from 55 s after the open to 115 s before the close.
"""
from __future__ import annotations

import argparse
import calendar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import polars as pl

REST = 'https://external-api.kalshi.com/trade-api/v2'
CACHE = Path(__file__).resolve().parent / 'cache'
TAPE = CACHE / 'tape'
SKIP_FIRST_S, SKIP_FINAL_S = 55, 115  # maker_study.py rests orders from 14 min to 2.5 min left, each live for 31 s
PAUSE_S = 0.15
SCHEMA = {'time': pl.Int64, 'yes_price': pl.Float64, 'taker_side': pl.String, 'count': pl.Float64}


def get(params: dict) -> dict:
    url = f'{REST}/markets/trades?{urllib.parse.urlencode(params)}'
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'accept': 'application/json', 'user-agent': 'research-client/1.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            time.sleep(5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError):
            time.sleep(5 * (attempt + 1))
    raise RuntimeError('Kalshi kept refusing or timing out')


def fetch_round(ticker: str, open_ms: int, close_ms: int) -> pl.DataFrame:
    rows, cursor = [], ''
    while True:
        params = {'ticker': ticker, 'limit': 1000, 'min_ts': open_ms // 1000 + SKIP_FIRST_S, 'max_ts': close_ms // 1000 - SKIP_FINAL_S}
        if cursor:
            params['cursor'] = cursor
        body = get(params)
        trades = body.get('trades') or []
        for t in trades:
            side = t.get('taker_outcome_side') or t.get('taker_side')
            try:
                stamp = t['created_time']
                # ISO time with microseconds and Z -> epoch ms
                sec = time.strptime(stamp[:19], '%Y-%m-%dT%H:%M:%S')
                frac = stamp[19:].rstrip('Z')
                ms = int(calendar.timegm(sec) * 1000 + (float(frac) * 1000 if frac else 0))
                rows.append((ms, float(t['yes_price_dollars']), side, float(t['count_fp'])))
            except (KeyError, ValueError, TypeError):
                continue
        cursor = body.get('cursor') or ''
        time.sleep(PAUSE_S)
        if not cursor or not trades:
            break
    return pl.DataFrame(rows, schema=SCHEMA, orient='row').filter(pl.col('taker_side').is_in(['yes', 'no'])).sort('time')


def journaled_rounds() -> pl.DataFrame:
    rounds = pl.read_parquet(CACHE / 'rounds.parquet').filter(pl.col('result').is_in(['yes', 'no']))
    ticks = pl.read_parquet(CACHE / 'ticks.parquet', columns=['ticker']).group_by('ticker').len().filter(pl.col('len') >= 600)
    return rounds.join(ticks, on='ticker', how='inner').sort('close')


def load() -> pl.DataFrame:
    """Every cached round, with its ticker."""
    files = sorted(TAPE.glob('*.parquet'))
    if not files:
        return pl.DataFrame(schema={'ticker': pl.String, **SCHEMA})
    return pl.concat([pl.read_parquet(f).with_columns(pl.lit(f.stem).alias('ticker')) for f in files]).select('ticker', *SCHEMA)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--every', type=int, default=4, help='take every Nth journaled round')
    ap.add_argument('--offset', type=int, default=0, help='start of the every-Nth pattern (0..N-1)')
    ap.add_argument('--limit', type=int, default=0, help='stop after this many new rounds (0 = no limit)')
    ap.add_argument('--workers', type=int, default=8, help='parallel connections (keep it small: this is a shared public API)')
    args = ap.parse_args()
    TAPE.mkdir(parents=True, exist_ok=True)
    rounds = journaled_rounds()
    picked = rounds.gather_every(args.every, offset=args.offset)
    todo = [r for r in picked.iter_rows(named=True) if not (TAPE / f"{r['ticker']}.parquet").exists()]
    print(f'{rounds.height} journaled rounds, {picked.height} picked, {len(todo)} to fetch', flush=True)
    if args.limit:
        todo = todo[:args.limit]
    started, done, trades = time.time(), 0, 0
    failed: list = []

    def one(r: dict) -> int:
        frame = fetch_round(r['ticker'], int(r['open']), int(r['close']))
        tmp = TAPE / f"{r['ticker']}.tmp"
        frame.write_parquet(tmp)
        tmp.replace(TAPE / f"{r['ticker']}.parquet")  # a killed run never leaves a half-written round behind
        return frame.height

    with ThreadPoolExecutor(max_workers=max(1, min(8, args.workers))) as pool:
        jobs = {pool.submit(one, r): r['ticker'] for r in todo}
        for fut in as_completed(jobs):
            try:
                trades += fut.result()
            except Exception as e:  # one round timing out must not stop the rest; it is fetched on the next run
                failed.append(jobs[fut])
                print(f'  skipped {jobs[fut]}: {type(e).__name__} {e}', flush=True)
                continue
            done += 1
            if done % 10 == 0 or done == len(todo):
                rate = (time.time() - started) / done
                print(f'{done}/{len(todo)} rounds, {trades:,} trades, {rate:.1f} s a round, about {(len(todo) - done) * rate / 60:.0f} min left', flush=True)
    print(f'done; {len(failed)} round(s) skipped, run again to retry them' if failed else 'done', flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
