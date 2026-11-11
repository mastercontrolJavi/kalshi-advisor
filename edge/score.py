"""Go/no-go scorer for the edge layer:  python -m edge.score [--db data/edge.db]

Brier scores (market_mid, p_base, p_math, q blended, q_raw, p_engine) overall and by minutes left, all on the same rows; the directional
call's hit rate against the "side the market favours" baseline; net P&L of TRADE fills with SE, 90% lower bound,
halves and drawdown; the PASS verdict; the ENGINE verdict (q_raw only); and the settlement proxy check."""
from __future__ import annotations

import argparse
import math
import sqlite3
import sys
from typing import Dict, Iterable, List, Optional, Sequence

from statistics import NormalDist

from .config import load_config
from .ev_gate import market_prob

_N = NormalDist()

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


def paired(rows: Sequence[dict], keys: Sequence[str] = MODELS) -> List[dict]:
    """Snapshot rows on which every model in `keys` that was logged at all has a value, so the Brier columns are
    compared on the same rows. TRADE rows are left out: they are picked for an extreme p_base, which is not a fair sample."""
    snaps = [r for r in rows if r.get('kind') != 'trade']
    cols = [k for k in keys if any(r.get(k) is not None for r in snaps)]
    return [r for r in snaps if all(r.get(k) is not None for k in cols)]


def engine_verdict(rows: Sequence[dict]) -> tuple:
    """ENGINE: ADDS SIGNAL only if q_raw (the stack before the Kalshi mid is blended in) beats p_base on >= 500 windows
    with the one-sided 95% bound of the Brier difference below zero. The bound treats each window as one observation:
    the snapshots inside a window share one outcome, so they are not independent evidence."""
    rows = [r for r in rows if r.get('kind') != 'trade' and r.get('q_raw') is not None and r.get('p_base') is not None]
    by_window: Dict[str, List[float]] = {}
    for r in rows:
        by_window.setdefault(r['ticker'], []).append((r['q_raw'] - r['outcome']) ** 2 - (r['p_base'] - r['outcome']) ** 2)
    diffs = [sum(v) / len(v) for v in by_window.values()]
    windows = len(diffs)
    raw, base = brier(rows, 'q_raw'), brier(rows, 'p_base')
    mean = sum(diffs) / windows if windows else None
    upper = None
    if windows > 1:
        upper = mean + 1.645 * math.sqrt(sum((d - mean) ** 2 for d in diffs) / (windows - 1) / windows)
    adds = windows >= ENGINE_MIN_WINDOWS and upper is not None and upper < 0
    return ('ENGINE: ADDS SIGNAL' if adds else 'ENGINE: NOT PROVEN'), windows, raw, base, mean, upper


def calibration(rows: Sequence[dict], key: str = 'p_base') -> Dict[str, List[tuple]]:
    """Per regime, 10-point bins of the prediction: (bin, mean predicted, realised YES rate, n)."""
    out: Dict[str, List[tuple]] = {}
    for regime in ('pre_window', 'final_minute'):
        bins: Dict[int, List[dict]] = {}
        for r in rows:
            if r.get('regime') == regime and r.get(key) is not None:
                bins.setdefault(min(9, int(r[key] * 10)), []).append(r)
        out[regime] = [(b, sum(r[key] for r in rs) / len(rs), sum(r['outcome'] for r in rs) / len(rs), len(rs)) for b, rs in sorted(bins.items())]
    return out


def disagreements(rows: Sequence[dict]) -> Dict[str, Optional[float]]:
    """MODEL_DISAGREE rows, one per window per minute left: how often the market's side won."""
    seen, market_right, model_right = set(), 0, 0
    for r in rows:
        if r.get('action') != 'MODEL_DISAGREE' or r.get('secs_left') is None:
            continue
        k = (r['ticker'], int(r['secs_left'] // 60))
        m = market_prob(r.get('market_mid'), r.get('yes_ask'), r.get('no_ask'))
        p = r.get('p_base')
        if k in seen or m is None or p is None:
            continue
        seen.add(k)
        market_right += int((m >= 0.5) == (r['outcome'] == 1))
        model_right += int((p >= 0.5) == (r['outcome'] == 1))
    n = len(seen)
    return {'n': n, 'market_side': market_right / n if n else None, 'model_side': model_right / n if n else None}


def tail_rescore(r: dict, tail: float = 1.0) -> Optional[float]:
    """p_base had sigma been scaled by `tail` instead of the row's TAIL_MULT. The mean does not depend on sigma, so
    z scales by TAIL_MULT/tail exactly: p' = Phi(z * TAIL_MULT / tail)."""
    used = r.get('tail_mult') or 1.15
    z = r.get('z')
    if z is None:
        p = r.get('p_base')
        if p is None:
            return None
        z = _N.inv_cdf(min(0.999, max(0.001, p)))
    return min(0.999, max(0.001, _N.cdf(z * used / tail)))


def score(db: sqlite3.Connection) -> Dict[str, object]:
    db.row_factory = sqlite3.Row
    settled = [dict(r) for r in db.execute('SELECT * FROM signals WHERE outcome IS NOT NULL ORDER BY ts')]
    fills = [dict(r) for r in db.execute("SELECT * FROM signals WHERE kind='trade' AND fill_price IS NOT NULL AND outcome IS NOT NULL ORDER BY fill_ts")]
    windows = [dict(r) for r in db.execute('SELECT * FROM windows WHERE result IS NOT NULL')]
    out: Dict[str, object] = {'rows': len(settled), 'windows': len({r['ticker'] for r in settled})}
    same = paired(settled)
    out['brier'] = {m: brier(same, m) for m in MODELS}
    out['brier_by_bucket'] = {name: {m: brier([r for r in same if r['secs_left'] is not None and bucket_of(r['secs_left']) == name], m) for m in MODELS}
                              for name, _, _ in BUCKETS}
    out['accuracy'] = accuracy(settled)
    out['calibration'] = calibration(settled)
    out['disagree'] = disagreements(settled)
    out['trades_tail'] = [(r['ticker'], r['side'], r['fill_price'], r['p_base'], r.get('tail_mult') or 1.15, tail_rescore(r), r['outcome']) for r in fills]
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
    lines.append('  every column is scored on the same rows (snapshots where all logged models have a value); TRADE rows are excluded.')
    a = s['accuracy']
    lines += ['', f"Directional call: {_f(a['engine'], 3)} right on {a['n']} rows; on {a['n_paired']} rows with a mid: engine {_f(a['engine_paired'], 3)} vs market favourite {_f(a['market_favourite'], 3)}"]
    lines += ['', 'p_base calibration (bin: predicted -> realised YES rate, n)']
    for regime, bins in s['calibration'].items():
        lines.append(f'  {regime}: ' + ('; '.join(f'{b * 10}-{b * 10 + 10}%: {pred * 100:.0f}% -> {real * 100:.0f}% ({n})' for b, pred, real, n in bins) or '—'))
    d = s['disagree']
    lines.append(f"MODEL_DISAGREE: {d['n']} window-minutes settled; market's side won {_f(d['market_side'], 3)}, model's side {_f(d['model_side'], 3)}")
    for ticker, side, price, p, tail, p1, y in s['trades_tail']:
        lines.append(f"  trade {ticker} {str(side).upper()} @ {price * 100:.1f}c: p_base {_f(p, 3)} (tail {tail:g}) -> {_f(p1, 3)} at tail 1.0; settled {'YES' if y else 'NO'}")
    f = s['fills']
    cents = lambda x: '—' if x is None else f'{x * 100:+.2f}c'
    lines += ['', f"TRADE fills {f['n']}: net {cents(f['mean'])}/contract, SE {cents(f['se'])}, LB90 {cents(f['lb90'])}, halves {cents(f['first_half'])} / {cents(f['second_half'])}, max drawdown ${_f(f['max_drawdown'], 2)}, total ${_f(f['total'], 2)}"]
    lines.append(f"VERDICT: {s['verdict']}  (needs >= {PASS_MIN_FILLS} fills, net >= +1.0c, LB90 > 0, both halves > 0)")
    label, windows, raw, base, diff, upper = s['engine']
    lines.append(f"{label}  (q_raw {_f(raw[0]) if raw else '—'} vs p_base {_f(base[0]) if base else '—'} on {windows} windows; difference per window {_f(diff)}, "
                 f"95% upper bound {_f(upper)}; needs >= {ENGINE_MIN_WINDOWS} windows and an upper bound below 0)")
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
