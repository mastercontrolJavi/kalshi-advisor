"""Go/no-go scorer for the edge layer:  python -m edge.score [--db data/edge.db]

Brier scores (market_mid, p_base, p_math, q blended, q_raw, p_engine) overall and by minutes left; the directional
call's hit rate against the "side the market favours" baseline; net P&L of TRADE fills with SE, 90% lower bound,
halves and drawdown; the PASS verdict; the ENGINE verdict (q_raw only); and the settlement proxy check."""
from __future__ import annotations

import argparse
import math
import sqlite3
import sys
from typing import Dict, Iterable, List, Optional, Sequence

from .config import load_config

BUCKETS = (('0-1', 0, 60), ('1-3', 60, 180), ('3-7', 180, 420), ('7-15', 420, 901))
MODELS = ('market_mid', 'p_base', 'p_math', 'q', 'q_raw', 'p_engine')
PASS_MIN_FILLS, PASS_MIN_NET, ENGINE_MIN_WINDOWS = 300, 0.01, 500


def brier(rows: Iterable[dict], key: str) -> Optional[tuple]:
    xs = [(r[key] - r['outcome']) ** 2 for r in rows if r.get(key) is not None]
    return (sum(xs) / len(xs), len(xs)) if xs else None


def bucket_of(secs_left: float) -> str:
    for name, lo, hi in BUCKETS:
        if lo <= secs_left < hi:
            return name
    return '7-15'


def accuracy(rows: Sequence[dict]) -> Dict[str, Optional[float]]:
    called = [r for r in rows if r.get('engine_call') in ('UP', 'DOWN')]
    hits = sum((r['engine_call'] == 'UP') == (r['outcome'] == 1) for r in called)
    fav = [r for r in called if r.get('market_mid') is not None]
    fav_hits = sum((r['market_mid'] >= 0.5) == (r['outcome'] == 1) for r in fav)
    eng_on_fav = sum((r['engine_call'] == 'UP') == (r['outcome'] == 1) for r in fav)
    return {'n': len(called), 'engine': hits / len(called) if called else None,
            'n_paired': len(fav), 'engine_paired': eng_on_fav / len(fav) if fav else None, 'market_favourite': fav_hits / len(fav) if fav else None}


def fill_pnl(r: dict) -> float:
    """Net P&L per contract: win = 1 - price - fee, loss = -price - fee (fee per contract)."""
    fee = (r['fee'] or 0.0) / max(1, r['contracts_filled'] or 1)
    win = (r['side'] == 'yes') == (r['outcome'] == 1)
    return (1 - r['fill_price'] - fee) if win else (-r['fill_price'] - fee)


def fills_report(fills: Sequence[dict]) -> Dict[str, Optional[float]]:
    xs = [fill_pnl(r) for r in fills]
    n = len(xs)
    if n == 0:
        return {'n': 0, 'mean': None, 'se': None, 'lb90': None, 'first_half': None, 'second_half': None, 'max_drawdown': None, 'total': None}
    mean = sum(xs) / n
    se = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1) / n) if n > 1 else None
    half = n // 2
    first, second = xs[:half], xs[half:]
    dollars = [x * (r['contracts_filled'] or 1) for x, r in zip(xs, fills)]
    peak = cum = dd = 0.0
    for d in dollars:
        cum += d
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return {'n': n, 'mean': mean, 'se': se, 'lb90': mean - 1.645 * se if se is not None else None,
            'first_half': sum(first) / len(first) if first else None, 'second_half': sum(second) / len(second) if second else None,
            'max_drawdown': dd, 'total': cum}


def verdict(f: Dict[str, Optional[float]]) -> str:
    ok = (f['n'] >= PASS_MIN_FILLS and f['mean'] is not None and f['mean'] >= PASS_MIN_NET and f['lb90'] is not None and f['lb90'] > 0
          and (f['first_half'] or 0) > 0 and (f['second_half'] or 0) > 0)
    return 'PASS' if ok else 'FAIL'


def engine_verdict(rows: Sequence[dict]) -> tuple:
    """ENGINE: ADDS SIGNAL only if q_raw (the stack before Kalshi's mid is blended in) beats p_base on >= 500 windows."""
    paired = [r for r in rows if r.get('q_raw') is not None and r.get('p_base') is not None]
    windows = len({r['ticker'] for r in paired})
    raw, base = brier(paired, 'q_raw'), brier(paired, 'p_base')
    adds = windows >= ENGINE_MIN_WINDOWS and raw is not None and base is not None and raw[0] < base[0]
    return ('ENGINE: ADDS SIGNAL' if adds else 'ENGINE: NOT PROVEN'), windows, raw, base


def score(db: sqlite3.Connection) -> Dict[str, object]:
    db.row_factory = sqlite3.Row
    settled = [dict(r) for r in db.execute('SELECT * FROM signals WHERE outcome IS NOT NULL ORDER BY ts')]
    fills = [dict(r) for r in db.execute("SELECT * FROM signals WHERE kind='trade' AND fill_price IS NOT NULL AND outcome IS NOT NULL ORDER BY fill_ts")]
    windows = [dict(r) for r in db.execute('SELECT * FROM windows WHERE result IS NOT NULL')]
    out: Dict[str, object] = {'rows': len(settled), 'windows': len({r['ticker'] for r in settled})}
    out['brier'] = {m: brier(settled, m) for m in MODELS}
    out['brier_by_bucket'] = {name: {m: brier([r for r in settled if r['secs_left'] is not None and bucket_of(r['secs_left']) == name], m) for m in MODELS}
                              for name, _, _ in BUCKETS}
    out['accuracy'] = accuracy(settled)
    out['fills'] = fills_report(fills)
    out['verdict'] = verdict(out['fills'])
    out['engine'] = engine_verdict(settled)
    checked = [w for w in windows if w['sign_agree'] is not None]
    disc = [abs(w['discrepancy']) for w in windows if w['discrepancy'] is not None]
    out['proxy'] = {'windows': len(checked), 'agree': sum(w['sign_agree'] for w in checked) / len(checked) if checked else None,
                    'mean_abs_usd': sum(disc) / len(disc) if disc else None, 'max_abs_usd': max(disc) if disc else None}
    return out


def _f(x, digits=4) -> str:
    return '—' if x is None else f'{x:.{digits}f}'


def report(s: Dict[str, object]) -> List[str]:
    lines = [f"Settled rows {s['rows']} across {s['windows']} windows", '', 'Brier (lower is better; n in brackets)']
    lines.append('  bucket   ' + ''.join(f'{m:>18}' for m in MODELS))
    for name, scores in [('all', s['brier'])] + list(s['brier_by_bucket'].items()):
        lines.append(f'  {name:<8} ' + ''.join(f"{(_f(v[0]) + f' [{v[1]}]') if v else '—':>18}" for v in (scores[m] for m in MODELS)))
    lines.append('  note: q (blended) is ~90% Kalshi mid, so q vs market_mid is mostly the market grading itself; use q_raw.')
    a = s['accuracy']
    lines += ['', f"Directional call: {_f(a['engine'], 3)} right on {a['n']} rows; on {a['n_paired']} rows with a mid: engine {_f(a['engine_paired'], 3)} vs market favourite {_f(a['market_favourite'], 3)}"]
    f = s['fills']
    cents = lambda x: '—' if x is None else f'{x * 100:+.2f}c'
    lines += ['', f"TRADE fills {f['n']}: net {cents(f['mean'])}/contract, SE {cents(f['se'])}, LB90 {cents(f['lb90'])}, halves {cents(f['first_half'])} / {cents(f['second_half'])}, max drawdown ${_f(f['max_drawdown'], 2)}, total ${_f(f['total'], 2)}"]
    lines.append(f"VERDICT: {s['verdict']}  (needs >= {PASS_MIN_FILLS} fills, net >= +1.0c, LB90 > 0, both halves > 0)")
    label, windows, raw, base = s['engine']
    lines.append(f"{label}  (q_raw {_f(raw[0]) if raw else '—'} vs p_base {_f(base[0]) if base else '—'} on {windows} windows; needs >= {ENGINE_MIN_WINDOWS})")
    p = s['proxy']
    agree = '—' if p['agree'] is None else '%.1f%%' % (p['agree'] * 100)
    lines.append(f"Proxy check: {agree} of {p['windows']} windows agree with Kalshi's settlement; mean |avg − Kalshi| ${_f(p['mean_abs_usd'], 2)}, max ${_f(p['max_abs_usd'], 2)}")
    return lines


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--db', default=load_config().DB_PATH)
    args = parser.parse_args(argv)
    try:  # Windows consoles default to cp1252, which cannot print the report's −, —, ¢ or σ
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass
    db =sqlite3.connect(f'file:{args.db}?mode=ro', uri=True)
    print('\n'.join(report(score(db))))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
