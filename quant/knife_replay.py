"""Replay of the bot's rule with three proposed fixes: a recalibrated fair value, a ceiling on the claimed edge and a
"no falling knife" direction filter, at the measured order latency.

    cd quant; uv run python study_data.py; uv run python vol_study.py; uv run python knife_replay.py   # -> output/quant/knife-replay.md

Read-only on the recorded journal. It does not import or change bot/: the rule (edge >= 3c after the taker fee, ask
10-30c or 70-97c, 2-10 minutes left, one buy a round, held to settlement) is restated here, as a flat 1 contract.

What is replayed
- Fair value: (shipped) edge/fair_value.py on the 300-s EWMA with a normal, as the bot prices today; (recalibrated)
  the walk-forward blend of the 300-s, 1-h and 4-h EWMAs with the two-scale shape from vol_study.py. Every second is
  priced with parameters fitted only on earlier calendar blocks, and both versions are scored on the same seconds.
- Edge cap: a side whose claimed edge is above the cap is not bought (treated as model error, not a discount).
- Direction filter: the side bought must be the side BRTI moved toward over the last 30 s.

Latency. The journal has one book per second, so a 110 ms order cannot be replayed directly. It is modelled as a
mixture: with probability f the order meets the next second's book (and, being immediate-or-cancel at the decided
ask, fills only if the ask is still at or under it), otherwise it meets the book it decided on. f comes from the
paper bot, which really did wait 300 ms against live books: it missed 65 of 384 orders. If quotes die at a constant
rate, f(110 ms) and f(200 ms) follow. 0 ms (not reachable) and a full second are shown as the two ends.
"""
from __future__ import annotations

import math
import sqlite3
import sys
from pathlib import Path

import numpy as np
import polars as pl
from scipy.stats import norm

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from edge.ev_gate import order_fee  # noqa: E402
from edge.fair_value import VARIOGRAM, WINDOW  # noqa: E402

import study_data as sd  # noqa: E402

CACHE = Path(__file__).resolve().parent / 'cache'
OUT = ROOT / 'output' / 'quant'
MIN_EDGE, MIN_ASK, MAX_ASK, BAND = 0.03, 0.10, 0.97, (0.30, 0.70)
MIN_LEFT, MAX_LEFT = 120, 600
EDGE_CAP, LOOKBACK_S = 0.06, 30
MAX_BOOK_DELAY_MS, MAX_PRINT_AGE_MS = 500, 2000
SEEDS = 20


def table(head, rows):
    return ['| ' + ' | '.join(head) + ' |', '|' + '|'.join(['---'] + ['---:'] * (len(head) - 1)) + '|'] + ['| ' + ' | '.join(r) + ' |' for r in rows]


def paper_miss_rate() -> tuple:
    """Orders the paper bot missed at its real 300 ms wait, from its own ledger (read-only)."""
    try:
        db = sqlite3.connect(f"file:{(ROOT / 'data' / 'bot.db').as_posix()}?mode=ro", uri=True)
        fills, misses = db.execute('SELECT COUNT(*) FROM fills').fetchone()[0], db.execute('SELECT COUNT(*) FROM misses').fetchone()[0]
        return misses, fills + misses
    except Exception:
        return 65, 384


class Data:
    def __init__(self):
        z = np.load(CACHE / 'study_var.npz')
        self.t0, self.price, self.ready = int(z['t0']), z['price'], z['ready']
        self.var = {'shipped': z['var_shipped'], 'recal': z['var_blend']}
        self.block, self.edges, self.mix = z['block'], z['edges'], z['mix']
        t = sd.ticks().sort('ticker', 'time')
        self.ticker = t['ticker'].to_numpy()
        _, self.tid = np.unique(self.ticker, return_inverse=True)
        self.sec = (t['time'].to_numpy() // 1000).astype(np.int64)
        ps = (t['brti_time'].to_numpy() // 1000).astype(np.int64)
        self.close = (t['close'].to_numpy() // 1000).astype(np.int64)
        self.left = (self.close - ps).astype(float)
        idx = ps - self.t0
        n = len(self.price)
        okidx = (idx >= LOOKBACK_S) & (idx < n)
        ic = np.clip(idx, LOOKBACK_S, n - 1)
        self.ya, self.na = t['yes_ask'].to_numpy(), t['no_ask'].to_numpy()
        self.yes = t['result'].to_numpy() == 'yes'
        k = t['k'].to_numpy()
        valid = (t['valid'].to_numpy() == 1) & (np.nan_to_num(t['book_delay'].to_numpy(), nan=0.0) <= MAX_BOOK_DELAY_MS)
        self.book_ok = valid
        spot = self.price[ic]
        self.mv = spot - self.price[ic - LOOKBACK_S]                 # BRTI move over the last 30 s (NaN if a print is missing)
        fresh = (t['time'].to_numpy() - t['brti_time'].to_numpy()) <= MAX_PRINT_AGE_MS
        self.base = (okidx & valid & fresh & self.ready[ic] & ~np.isnan(spot) & (self.block[ic] >= 1) & ~np.isnan(self.var['recal'][ic])
                     & (self.left > MIN_LEFT) & (self.left <= MAX_LEFT) & (k > 0))
        units = np.ones(len(ic))
        m = self.base
        units[m] = [VARIOGRAM.pre_window(x - WINDOW) for x in self.left[m]]
        zs = np.zeros(len(ic))
        self.p = {}
        zs[m] = (spot[m] - k[m]) / (spot[m] * np.sqrt(self.var['shipped'][ic][m] * units[m]))
        self.p['shipped'] = np.clip(norm.cdf(zs), 0.001, 0.999)
        zr = np.zeros(len(ic))
        zr[m] = (spot[m] - k[m]) / (spot[m] * np.sqrt(self.var['recal'][ic][m] * units[m]))
        mx = self.mix[self.block[ic]]
        with np.errstate(invalid='ignore'):
            self.p['recal'] = np.clip(np.nan_to_num(mx[:, 0] * norm.cdf(zr / mx[:, 1]) + (1 - mx[:, 0]) * norm.cdf(zr / mx[:, 2]), nan=0.5), 0.001, 0.999)
        self.nxt = {}                                                # row -> the same round's row d seconds later
        same = lambda d: np.flatnonzero((self.tid[d:] == self.tid[:-d]) & (self.sec[d:] - self.sec[:-d] == d))
        self.order = np.arange(len(self.sec))
        self._key = self.tid.astype(np.int64) * 10_000_000_000 + self.sec
        self._sorted = np.argsort(self._key)
        self._keys_sorted = self._key[self._sorted]

    def later(self, i: int, d: int):
        j = np.searchsorted(self._keys_sorted, self._key[i] + d)
        if j < len(self._keys_sorted) and self._keys_sorted[j] == self._key[i] + d:
            return int(self._sorted[j])
        return None


def signals(D: Data, model: str, cap: bool, direction: bool):
    """Per journal second: the side the rule would buy (0 none, 1 yes, 2 no), its ask and its claimed edge."""
    p = D.p[model]
    out = []
    for side, q, ask, agree in ((1, p, D.ya, D.mv > 0), (2, 1 - p, D.na, D.mv < 0)):
        a = np.nan_to_num(ask, nan=-1.0)
        edge = q - a - 0.07 * a * (1 - a)
        ok = D.base & (a > 0) & (a < 1) & (edge >= MIN_EDGE) & (a >= MIN_ASK) & (a <= MAX_ASK) & ~((a >= BAND[0]) & (a <= BAND[1]))
        if cap:
            ok &= edge <= EDGE_CAP
        if direction:
            ok &= agree
        out.append((np.where(ok, edge, -np.inf), a))
    (ey, ay), (en, an) = out
    side = np.where((ey == -np.inf) & (en == -np.inf), 0, np.where(ey >= en, 1, 2))
    return side, np.where(side == 1, ay, an), np.where(side == 1, ey, en)


def replay(D: Data, side, ask, edge, f: float = 0.0, delay: int = 0, seed: int = 0):
    """One pass. f: chance an order meets the next second's book (delay 0). delay >= 1: every order meets the book
    `delay` seconds later. Returns per-fill rows (round id, close, net per contract, price, won, claimed edge) and the
    close time of the round of every order sent."""
    rows, orders = [], []
    cand = np.flatnonzero(side > 0)
    rng = np.random.default_rng(seed)
    draws = rng.random(len(cand)) if 0 < f < 1 else None
    done, wait = set(), {}
    for n, i in enumerate(cand):
        r = D.tid[i]
        if r in done or wait.get(r, 0) > D.sec[i]:
            continue
        orders.append(D.close[i])
        s = side[i]
        late = delay if delay else (1 if (f >= 1 or (draws is not None and draws[n] < f)) else 0)
        price = None
        if late == 0:
            price = ask[i]
        else:
            j = D.later(i, late)
            if j is not None and D.book_ok[j] and D.sec[j] < D.close[j] - 1:
                a = D.ya[j] if s == 1 else D.na[j]
                if a is not None and a == a and a <= ask[i] + 1e-9:   # immediate-or-cancel at the decided ask
                    price = float(a)
        if price is None:
            wait[r] = D.sec[i] + 2 + (late if delay else 0)           # the bot's 1-second cooldown after a miss
            continue
        done.add(r)
        won = (s == 1) == bool(D.yes[i])
        rows.append((r, D.close[i], (1.0 if won else 0.0) - price - order_fee(price, 1), price, won, edge[i]))
    return rows, orders


def summarise(runs, lo_close=None, n_boot=2000, seed=7):
    """runs: list of (rows, orders) over seeds. Mean net per contract with a 95% range that resamples rounds."""
    rows = [r for rs, _ in runs for r in rs if lo_close is None or r[1] >= lo_close]
    orders = sum(1 for _, o in runs for c in o if lo_close is None or c >= lo_close)
    if len(rows) < 5:
        return None
    rid = np.array([r[0] for r in rows]); net = np.array([r[2] for r in rows])
    uniq, inv = np.unique(rid, return_inverse=True)
    sums, counts = np.bincount(inv, weights=net), np.bincount(inv)
    d = np.random.default_rng(seed).integers(0, len(uniq), size=(n_boot, len(uniq)))
    est = sums[d].sum(1) / counts[d].sum(1)
    return {'fills': len(rows) / len(runs), 'rounds': len(uniq), 'orders': orders / len(runs), 'net': net.mean(), 'lo': np.percentile(est, 2.5), 'hi': np.percentile(est, 97.5),
            'win': np.mean([r[4] for r in rows]), 'price': np.mean([r[3] for r in rows]), 'edge': np.mean([r[5] for r in rows])}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    D = Data()
    day = lambda t: np.datetime64(int(t), 's').astype('datetime64[D]')
    misses, sent = paper_miss_rate()
    variants = [('shipped', False, False), ('shipped', True, False), ('shipped', False, True), ('shipped', True, True),
                ('recal', False, False), ('recal', True, False), ('recal', False, True), ('recal', True, True)]
    label = lambda m, c, d: ('recalibrated' if m == 'recal' else 'as shipped') + (f' + cap {EDGE_CAP * 100:.0f}c' if c else '') + (' + direction' if d else '')
    sig = {v: signals(D, *v) for v in variants}

    # quote survival on the shipped rule's first order of each round
    side, ask, edge = sig[variants[0]]
    first, seen = [], set()
    for i in np.flatnonzero(side > 0):
        if D.tid[i] not in seen:
            seen.add(D.tid[i]); first.append(i)
    surv = {}
    for d in (1, 2, 3, 5):
        up = down = same = 0
        for i in first:
            j = D.later(i, d)
            if j is None or not D.book_ok[j]:
                continue
            a = D.ya[j] if side[i] == 1 else D.na[j]
            if a is None or a != a:
                continue
            up += a > ask[i] + 1e-9; down += a < ask[i] - 1e-9; same += abs(a - ask[i]) <= 1e-9
        tot = up + down + same
        surv[d] = (up / tot, down / tot, same / tot, tot)
    m1 = surv[1][0]
    p300 = misses / sent
    f300 = min(1.0, p300 / m1) if m1 > 0 else 1.0
    haz = lambda ms: 1.0 if f300 >= 1 else 1 - (1 - f300) ** (ms / 300.0)
    F = {'0 ms (not reachable)': dict(f=0.0), '110 ms': dict(f=haz(110)), '200 ms': dict(f=haz(200)), '1 s': dict(delay=1)}
    holdout = 1794009600                                              # 2026-11-07 00:00 UTC: after the data VAR_RATIO and the bands were fitted on
    md = ['# Replay: recalibrated fair value, edge cap, direction filter', '',
          f'{len(np.unique(D.tid[D.base])):,} settled rounds with priced seconds, {day(D.edges[1])} to {day(D.sec.max())} (every second priced with parameters from earlier blocks only). '
          f'Flat 1 contract, exact taker fee (0.07 x P x (1 - P), rounded up to $0.0001), held to settlement. Edge cap {EDGE_CAP * 100:.0f}c; direction = BRTI moved toward the side '
          f'bought over the last {LOOKBACK_S} s. Guards as the bot now has them (book at most {MAX_BOOK_DELAY_MS} ms behind).', '',
          '## Latency model', '',
          f'On the shipped rule\'s first order of each round ({surv[1][3]:,} rounds), the ask for the side wanted, d seconds later:', '']
    md += table(['seconds later', 'higher (an IOC order misses)', 'lower', 'unchanged'], [[str(d), f'{100 * surv[d][0]:.0f}%', f'{100 * surv[d][1]:.0f}%', f'{100 * surv[d][2]:.0f}%'] for d in surv])
    md += ['', f'The paper bot, waiting a real 300 ms against live books, missed {misses} of {sent} orders ({100 * p300:.0f}%). A miss needs the next book AND a higher ask, so the '
           f'chance that a 300 ms order already meets the next second\'s book is {100 * p300:.0f}% / {100 * m1:.0f}% = **{100 * f300:.0f}%**'
           + (' (capped at 100%: the repricing is over within 300 ms)' if f300 >= 1 else '') + f'. At a constant rate that is **{100 * haz(110):.0f}% at 110 ms** and **{100 * haz(200):.0f}% at 200 ms**. '
           'This is the weakest link in the study: one number from 384 paper orders stands in for sub-second book data that was never recorded.', '']
    results = {}
    for v in variants:
        s_, a_, e_ = sig[v]
        for name, kw in F.items():
            if 'delay' in kw or kw['f'] in (0.0, 1.0):
                runs = [replay(D, s_, a_, e_, **kw)]
            else:
                runs = [replay(D, s_, a_, e_, seed=k, **kw) for k in range(SEEDS)]
            results[(v, name)] = runs
    for title, lo_close in ((f'All out-of-sample rounds ({day(D.edges[1])} on)', None), ('Hold-out only: rounds closing from 2026-11-07', holdout)):
        md += [f'## {title}', '', 'Net cents per contract after the fee, with the 95% bootstrap range over rounds; fills / orders is the fill rate.', '']
        rows = []
        for v in variants:
            cells = [label(*v)]
            for name in F:
                r = summarise(results[(v, name)], lo_close)
                cells.append('-' if r is None else f'**{100 * r["net"]:+.2f}c** ({100 * r["lo"]:+.1f} .. {100 * r["hi"]:+.1f}); {r["fills"]:.0f} fills')
            r = summarise(results[(v, '110 ms')], lo_close)
            cells += ['-' if r is None else f'{100 * r["fills"] / r["orders"]:.0f}%', '-' if r is None else f'{100 * r["win"]:.0f}% at {100 * r["price"]:.0f}c', '-' if r is None else f'{100 * r["edge"]:.1f}c']
            rows.append(cells)
        md += table(['rule'] + list(F) + ['fill rate at 110 ms', 'won, average price', 'claimed edge'], rows)
        md += ['']
    # decay by whole seconds, shipped and the full fix
    md += ['## How fast the result decays (all out-of-sample rounds)', '']
    rows = []
    for v in (variants[0], variants[7]):
        s_, a_, e_ = sig[v]
        cells = [label(*v)]
        for d in (0, 1, 2, 3, 5):
            r = summarise([replay(D, s_, a_, e_, delay=d)] if d else results[(v, '0 ms (not reachable)')])
            cells.append('-' if r is None else f'{100 * r["net"]:+.2f}c ({100 * r["lo"]:+.1f} .. {100 * r["hi"]:+.1f})')
        rows.append(cells)
    md += table(['rule', 'same second', '1 s', '2 s', '3 s', '5 s'], rows)
    # where the shipped rule's money goes, by claimed edge and by direction
    s_, a_, e_ = sig[variants[0]]
    rws, _ = replay(D, s_, a_, e_, delay=1)
    net = np.array([r[2] for r in rws]); ed = np.array([r[5] for r in rws]); cl = np.array([r[1] for r in rws])
    md += ['', '## The shipped rule filled 1 s later, split by what the two filters look at', '']
    rows = []
    for nm, m in (('claimed edge 3-6c', ed <= EDGE_CAP), (f'claimed edge above {EDGE_CAP * 100:.0f}c', ed > EDGE_CAP)):
        if m.sum() > 4:
            h = 1.96 * net[m].std(ddof=1) / math.sqrt(m.sum())
            rows.append([nm, f'{m.sum():,}', f'{100 * net[m].mean():+.2f}c', f'{100 * (net[m].mean() - h):+.1f} .. {100 * (net[m].mean() + h):+.1f}'])
    md += table(['fills', 'n', 'net per contract', '95%'], rows)
    md += ['']
    (OUT / 'knife-replay.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
