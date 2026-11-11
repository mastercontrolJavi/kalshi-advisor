"""Resting (maker) orders on KXBTC15M, simulated against Kalshi's public trade tape.

    cd quant; uv run python tape.py --every 4     # once: download the tape for a sample of journaled rounds
    uv run python maker_study.py                  # report -> output/quant/maker-study.md

The question: a resting order pays no fee on this series and buys at the bid instead of the ask. Does that make it
profitable, or do fills only come when the price is about to move against you?

Every 15 s from 14 min to 2.5 min left, and on both sides, a 1-contract bid is rested at the best bid the journal saw
that second (a NO bid is a YES offer). It goes live 1 s later (network and clock slack) and is cancelled after 30 s
(`--latency`, `--life`). A bid the ask has already come down to by the time it arrives is a take, not a resting order.
Three ways of deciding whether it filled, from strict to generous:

  through     a trade printed strictly beyond our price, so our level was emptied. Queue position cannot matter.
  queue       we join the BACK of the displayed size at our price; we fill once that much has traded there, or on a
              through print. Nobody ahead of us ever cancels.
  queue+      as queue, but whenever the displayed size at our price drops below our position (people ahead cancelled),
              we move up to it. The most generous reading the 1-s book supports.

Each fill is scored three ways: held to settlement (the truth, but noisy: +/- 40c a fill), and the Kalshi mid 10 s and
60 s after the fill minus the price paid (the "markout": what the position is worth once the market has digested
whatever filled us; far less noisy, and Kalshi's mid is calibrated to within a point). 95% ranges resample whole rounds.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import polars as pl
from scipy.stats import norm

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from edge.config import load_config  # noqa: E402
from edge.fair_value import VARIOGRAM, WINDOW  # noqa: E402
import edge_calibration as ec  # noqa: E402
import tape as tape_mod  # noqa: E402

OUT = ROOT / 'output' / 'quant'
LIFE_S, LATENCY_MS = 30, 1000       # --life / --latency change these for the sensitivity runs
TAPE_END_S = 116                    # tape.py stops 115 s before the close


def grid() -> list:
    """Seconds left at placement: every 15 s from 14 min down to the last order whose whole life the tape covers."""
    return list(range(840, TAPE_END_S + 2 + LATENCY_MS // 1000 + LIFE_S, -15))


EPS = 1e-6
FILLS = ('through', 'queue', 'queue+')


def taker_fee(p: float) -> float:
    return 0.07 * p * (1 - p)


def level_size(ladder: list, price: float) -> float:
    for p, s in ladder:
        if abs(p - price) < EPS:
            return float(s)
    return 0.0


def simulate_round(tk: str, close_ms: int, yes: bool, ticks: pl.DataFrame, trades: pl.DataFrame, p_model: dict) -> list:
    """All grid orders of one round. ticks: this round's journal rows; trades: this round's tape; p_model: tau -> P(YES)."""
    by_tau = {}
    for r in ticks.iter_rows(named=True):
        by_tau[int(round(r['tau']))] = r
    mid = np.full(902, np.nan)
    for tau, r in by_tau.items():
        if 0 <= tau <= 900 and r['yes_bid'] is not None and r['yes_ask'] is not None and r['valid'] and (r['book_delay'] or 0) <= 2000 and r['yes_ask'] - r['yes_bid'] <= 0.10 + EPS:
            mid[tau] = (r['yes_bid'] + r['yes_ask']) / 2
    ladders: dict = {}

    def ladder(tau: int, side: str) -> list:
        key = (tau, side)
        if key not in ladders:
            r = by_tau.get(tau)
            raw = r and r['book_yes' if side == 'yes' else 'book_no']
            try:
                ladders[key] = json.loads(raw) if raw else []
            except ValueError:
                ladders[key] = []
        return ladders[key]

    def mid_at(tau: float) -> float:
        """Kalshi mid at `tau` seconds left (nearest live second within 2 s)."""
        base = int(round(tau))
        for d in (0, -1, 1, -2, 2):
            t = base + d
            if 0 <= t <= 900 and not np.isnan(mid[t]):
                return float(mid[t])
        return float('nan')

    tt = trades['time'].to_numpy(); pp = trades['yes_price'].to_numpy(); cc = trades['count'].to_numpy()
    taker_yes = (trades['taker_side'] == 'yes').to_numpy()
    out = []
    lat = LATENCY_MS // 1000
    for tau in grid():
        r = by_tau.get(tau)
        if r is None or np.isnan(mid[tau]):
            continue
        t_place = close_ms - tau * 1000
        t0, t1 = t_place + LATENCY_MS, t_place + LATENCY_MS + LIFE_S * 1000
        lo, hi = np.searchsorted(tt, t0, 'right'), np.searchsorted(tt, t1, 'right')
        nxt = by_tau.get(tau - lat)
        for side in ('yes', 'no'):
            # our bid in the side's own price; the same level in YES-price terms; which takers hit it
            if side == 'yes':
                limit, level, hits = r['yes_bid'], r['yes_bid'], ~taker_yes[lo:hi]
                through_px = pp[lo:hi] < level - EPS
                ask_now = nxt['yes_ask'] if nxt else None
            else:
                limit, level, hits = 1 - r['yes_ask'], r['yes_ask'], taker_yes[lo:hi]
                through_px = pp[lo:hi] > level + EPS
                ask_now = (1 - nxt['yes_bid']) if nxt and nxt['yes_bid'] is not None else None
            if limit is None or not (0.02 <= limit <= 0.98):
                continue
            if ask_now is None or not (0 < ask_now < 1):
                continue
            # The order arrives LATENCY_MS after the snapshot it was priced from. If the ask has come down to our price by then
            # it would trade at once as a TAKER (with the fee), or be rejected as post-only: either way not a resting order.
            posted = ask_now > limit + EPS
            arrive = ladder(tau - lat, side)
            q0 = level_size(arrive, limit)
            if q0 <= 0:
                if arrive and arrive[0][0] < limit - EPS:
                    q0 = 0.0  # everyone at our price left in that second: we are alone at the front
                else:
                    q0 = level_size(ladder(tau, side), limit)
                    if q0 <= 0:
                        continue
            w_t, w_c = tt[lo:hi], cc[lo:hi]
            at = hits & (np.abs(pp[lo:hi] - level) < EPS)
            thr = hits & through_px
            first_thr = int(np.argmax(thr)) if thr.any() else -1
            # queue: back of the displayed size, nobody ahead cancels
            cum = np.cumsum(np.where(at, w_c, 0.0))
            done = np.flatnonzero(cum > q0)
            first_q = int(done[0]) if done.size else -1
            # queue+: position capped by the displayed size at our level each later second
            first_qp, pos, prev_cum, i = -1, q0, 0.0, 0
            for s in range(lat, lat + LIFE_S + 1):
                edge_ms = t_place + s * 1000
                j = int(np.searchsorted(w_t, edge_ms, 'right'))
                if j > i:
                    seg = np.cumsum(np.where(at[i:j], w_c[i:j], 0.0))
                    k = np.flatnonzero(seg > pos)
                    if k.size:
                        first_qp = i + int(k[0]); break
                    pos -= float(seg[-1]) if seg.size else 0.0
                    i = j
                lad = ladder(tau - s, side)
                if lad:
                    pos = min(pos, level_size(lad, limit))
            fills = {}
            for name, idx in (('through', first_thr), ('queue', min([x for x in (first_thr, first_q) if x >= 0], default=-1)),
                              ('queue+', min([x for x in (first_thr, first_q, first_qp) if x >= 0], default=-1))):
                fills[name] = float(w_t[idx]) if idx >= 0 and posted else float('nan')
            win = 1.0 if (side == 'yes') == yes else 0.0
            p_side = p_model.get(tau)
            p_side = None if p_side is None else (p_side if side == 'yes' else 1 - p_side)
            # first second after placement when the model says our bid is above fair value (cancel 1 s later)
            cancel_ms = float('nan')
            if p_side is not None:
                for s in range(1, LIFE_S + 1):
                    ps = p_model.get(tau - s)
                    if ps is None:
                        continue
                    if (ps if side == 'yes' else 1 - ps) < limit:
                        cancel_ms = t_place + s * 1000 + LATENCY_MS
                        break
            m_now = mid[tau] if side == 'yes' else 1 - mid[tau]
            mom = mid_at(tau) - mid_at(tau + 60)  # the last minute's move in the YES price
            with_move = None if math.isnan(mom) or abs(mom) < EPS else bool((mom > 0) == (side == 'yes'))
            row = {'ticker': tk, 'close': close_ms, 'tau': tau, 'side': side, 'limit': float(limit), 'q0': q0, 'win': win, 'mid_now': float(m_now),
                   'posted': posted, 'with_move': with_move,
                   'p_side': p_side, 'cancel_ms': cancel_ms,
                   'taker_cost': (float(ask_now) + taker_fee(float(ask_now))) if ask_now is not None and 0 < ask_now < 1 else float('nan')}
            # the same side's taker cost just after the resting order would have been cancelled (rest first, then take)
            late = by_tau.get(tau - lat - LIFE_S - 1)
            late_ask = None
            if late is not None and not np.isnan(mid[tau - lat - LIFE_S - 1]):
                late_ask = late['yes_ask'] if side == 'yes' else 1 - late['yes_bid']
            row['late_cost'] = (float(late_ask) + taker_fee(float(late_ask))) if late_ask is not None and 0 < late_ask < 1 else float('nan')
            slow = p_model.get(tau + 2)  # the model as it stood 2 s earlier: 3 s old by the time the order is live
            row['p_side_slow'] = None if slow is None else (slow if side == 'yes' else 1 - slow)
            m60_dec = mid_at(tau - lat - 60)
            row['taker_m60'] = (m60_dec if side == 'yes' else 1 - m60_dec) if not math.isnan(m60_dec) else float('nan')
            for name in FILLS:
                tf = fills[name]
                row[f't_{name}'] = tf
                if math.isnan(tf):
                    row[f'm0_{name}'] = row[f'm10_{name}'] = row[f'm60_{name}'] = float('nan')
                    continue
                tau_f = (close_ms - tf) / 1000
                for lab, d in (('m0', 0), ('m10', 10), ('m60', 60)):
                    v = mid_at(tau_f - d)
                    row[f'{lab}_{name}'] = (v if side == 'yes' else 1 - v) if not math.isnan(v) else float('nan')
            out.append(row)
    return out


def model_probs(ar: ec.Archive, close_s: int, strike: float, sigma_scale: float = 1.0) -> dict:
    """The sidecar's p_base (new formula) for each second from 870 s to 61 s left; tau -> P(YES)."""
    out = {}
    for tau in range(870, WINDOW, -1):
        i = close_s - tau - ar.t0
        if i < 0 or i >= ar.n or not ar.ok[i] or not ar.ready[i]:
            continue
        sd = ar.price[i] * math.sqrt(ar.var[i] * VARIOGRAM.pre_window(tau - WINDOW)) * sigma_scale
        out[tau] = float(min(0.999, max(0.001, norm.cdf((ar.price[i] - strike) / sd)))) if sd > 0 else None
    return out


def boot(values: np.ndarray, groups: np.ndarray, n: int = 2000, seed: int = 5):
    ok = ~np.isnan(values)
    values, groups = values[ok], groups[ok]
    if len(values) < 5:
        return float('nan'), float('nan'), float('nan'), 0
    uniq, inv = np.unique(groups, return_inverse=True)
    sums, counts = np.bincount(inv, weights=values), np.bincount(inv)
    draws = np.random.default_rng(seed).integers(0, len(uniq), size=(n, len(uniq)))
    est = sums[draws].sum(1) / np.maximum(counts[draws].sum(1), 1)
    return float(values.mean()), float(np.percentile(est, 2.5)), float(np.percentile(est, 97.5)), len(values)


def c(x: float) -> str:
    return '—' if x is None or (isinstance(x, float) and math.isnan(x)) else f'{x * 100:+.2f}c'


def rng(t: tuple) -> str:
    return f'**{c(t[0])}** ({c(t[1])} to {c(t[2])})' if t[3] else '—'


def summary_rows(df: pl.DataFrame, label: str, mask: np.ndarray, fills=FILLS) -> list:
    rows = []
    g = df['ticker'].to_numpy()
    lim, win = df['limit'].to_numpy(), df['win'].to_numpy()
    mask = mask & df['posted'].to_numpy()
    for name in fills:
        tf = df[f't_{name}'].to_numpy()
        filled = mask & ~np.isnan(tf)
        n_orders, n_f = int(mask.sum()), int(filled.sum())
        if n_f < 20:
            rows.append([label, name, f'{n_orders:,}', f'{n_f:,}', '—', '—', '—', '—', '—'])
            continue
        v = lambda col: np.where(filled, df[col].to_numpy() - lim, np.nan)
        settle = np.where(filled, win - lim, np.nan)
        rows.append([label, name, f'{n_orders:,}', f'{n_f:,} ({n_f / n_orders * 100:.0f}%)', c(float(np.nanmean(v(f"m0_{name}")))),
                     rng(boot(v(f'm10_{name}'), g)), rng(boot(v(f'm60_{name}'), g)), rng(boot(settle, g)), f'{len(np.unique(g[filled])):,}'])
    return rows


def main() -> None:
    global LIFE_S, LATENCY_MS
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--life', type=int, default=LIFE_S, help='seconds a bid rests before it is cancelled')
    ap.add_argument('--latency', type=int, default=LATENCY_MS // 1000, help='seconds between the book snapshot and the order being live')
    ap.add_argument('--out', default='maker-study.md')
    args = ap.parse_args()
    LIFE_S, LATENCY_MS = args.life, args.latency * 1000
    cfg = load_config()
    tape_files = sorted(tape_mod.TAPE.glob('*.parquet'))
    if not tape_files:
        raise SystemExit('No tape cached: run `uv run python tape.py --every 4` first.')
    have = {f.stem for f in tape_files}
    rounds = pl.read_parquet(ec.CACHE / 'rounds.parquet').filter(pl.col('ticker').is_in(list(have)) & pl.col('result').is_in(['yes', 'no'])).sort('close')
    ticks = pl.read_parquet(ec.CACHE / 'ticks.parquet', columns=['ticker', 'tau', 'yes_bid', 'yes_ask', 'valid', 'book_delay', 'book_yes', 'book_no']).filter(pl.col('ticker').is_in(list(have)))
    by_ticker = ticks.partition_by('ticker', as_dict=True)
    ar = ec.Archive(cfg)
    rows = []
    for r in rounds.iter_rows(named=True):
        tk = r['ticker']
        t = by_ticker.get((tk,))
        if t is None or t.height < 600:
            continue
        probs = model_probs(ar, int(r['close'] // 1000), float(r['strike'])) if r['strike'] else {}
        rows += simulate_round(tk, int(r['close']), r['result'] == 'yes', t, pl.read_parquet(tape_mod.TAPE / f'{tk}.parquet'), probs)
    df = pl.DataFrame(rows, infer_schema_length=None)
    n_rounds = df['ticker'].n_unique()
    lim, tau, side = df['limit'].to_numpy(), df['tau'].to_numpy(), df['side'].to_numpy()
    close = df['close'].to_numpy()
    allm = np.ones(df.height, bool)
    head = ['orders', 'fill rule', 'placed', 'filled', 'mid at fill - price', 'mid 10 s later - price', 'mid 60 s later - price', 'held to settlement', 'rounds']
    md = ['# Resting orders on KXBTC15M against the public trade tape', '',
          f'{n_rounds:,} rounds with both the journal\'s 1-s book and Kalshi\'s trade tape ({pl.from_epoch(pl.Series([int(close.min())]), time_unit="ms")[0]:%b %d} to '
          f'{pl.from_epoch(pl.Series([int(close.max())]), time_unit="ms")[0]:%b %d}), {df.height:,} simulated 1-contract bids at the best bid, live {LATENCY_MS / 1000:.0f} s after the '
          f'book snapshot, cancelled after {LIFE_S} s. No fee (KXBTC15M makers pay none). All numbers are per filled contract; ranges are 95%, resampling whole rounds.', '',
          'Reading the columns: "mid at fill − price" is the half-spread you appear to earn at the instant of the fill. The next two columns are what is left of it 10 s and 60 s later. '
          'If a fill is worth less a minute later than you paid, the order was picked off.', '', '## 1. Every bid, both sides', '']
    md += ec.table(head, summary_rows(df, 'all', allm))

    md += ['', '## 2. By price of the side bought', '']
    rows_ = []
    for lab, lo, hi in (('longshot, under 30c', 0, 0.30), ('middle, 30-70c', 0.30, 0.70), ('favourite, over 70c', 0.70, 1.0)):
        rows_ += summary_rows(df, lab, (lim >= lo) & (lim < hi))
    md += ec.table(head, rows_)

    md += ['', '## 3. By time left when placed', '']
    rows_ = []
    for lab, lo, hi in (('7-14 min', 420, 900), ('2.5-7 min', 149, 420)):
        rows_ += summary_rows(df, lab, (tau > lo) & (tau <= hi), fills=('queue', 'queue+'))
    md += ec.table(head, rows_)

    # model-filtered, with and without cancel
    p_side = df['p_side'].to_numpy().astype(float)
    md += ['', '## 4. Only where the model says the bid is cheap', '',
           'Rest only on the side where the sidecar\'s fair value (new formula) is at least 1c / 3c above the bid. "With cancel" pulls the order 1 s after the model first says the bid is above fair value.', '']
    rows_ = []
    for edge in (0.01, 0.03):
        base = ~np.isnan(p_side) & (p_side - lim >= edge)
        rows_ += summary_rows(df, f'model edge >= {edge * 100:.0f}c, no cancel', base, fills=('queue', 'queue+'))
        d2 = df.clone()
        cm = df['cancel_ms'].to_numpy()
        for name in ('queue', 'queue+'):
            tf = df[f't_{name}'].to_numpy()
            kill = ~np.isnan(cm) & ~np.isnan(tf) & (tf > cm)
            d2 = d2.with_columns(pl.Series(f't_{name}', np.where(kill, np.nan, tf)))
        rows_ += summary_rows(d2, f'model edge >= {edge * 100:.0f}c, with cancel', base, fills=('queue', 'queue+'))
    slow = df['p_side_slow'].to_numpy().astype(float)
    rows_ += summary_rows(df, 'model edge >= 3c on 3-s-old information, no cancel', ~np.isnan(slow) & (slow - lim >= 0.03), fills=('queue', 'queue+'))
    md += ec.table(head, rows_)

    # taker on the same decisions
    g = df['ticker'].to_numpy()
    tc, win = df['taker_cost'].to_numpy(), df['win'].to_numpy()
    md += ['', '## 5. The same decisions as a taker', '',
           'Buy the same side at the ask one second after the same snapshot and pay the fee. This is what resting is trying to beat.', '']
    rows_ = []
    for lab, mask in (('all', allm), ('longshot, under 30c', lim < 0.30), ('middle, 30-70c', (lim >= 0.30) & (lim < 0.70)), ('favourite, over 70c', lim >= 0.70)):
        ok = mask & ~np.isnan(tc)
        rows_.append([lab, f'{int(ok.sum()):,}', rng(boot(np.where(ok, df['taker_m60'].to_numpy() - tc, np.nan), g)), rng(boot(np.where(ok, win - tc, np.nan), g))])
    md += ec.table(['orders', 'taken', 'mid 60 s later - cost', 'held to settlement'], rows_)

    # rest first, then take: an execution comparison for a buyer who will hold the position either way
    late = df['late_cost'].to_numpy()
    md += ['', '## 6. If you were going to buy that side anyway: rest first, then take', '',
           f'Two ways to end up holding the same contract. A: take the ask now and pay the fee. B: rest at the bid for {LIFE_S} s; if it has not filled, take the ask then (and if the ask has already come down to the bid when the order arrives, it is simply a take, same as A). '
           'The saving is A\'s cost minus B\'s, per contract, whatever the round does afterwards (the position is the same, so where the price goes cancels out). '
           'A fill saves a tick plus the fee; a miss means paying a price that has usually moved away.', '']
    rows_ = []
    posted = df['posted'].to_numpy()
    wm = df['with_move'].to_numpy()
    with_move, against = np.array([v is True for v in wm]), np.array([v is False for v in wm])

    def saving(name: str):
        tf = df[f't_{name}'].to_numpy()
        ok = ~np.isnan(tc) & (~posted | ~np.isnan(tf) | ~np.isnan(late))
        # crossed on arrival: B is just a take at the same price as A. Filled: paid the bid, no fee. Missed: take 31 s later.
        cost_b = np.where(~posted, tc, np.where(~np.isnan(tf), lim, late))
        return ok, tf, np.where(ok, tc - cost_b, np.nan)

    for lab, mask in (('all', allm), ('longshot, under 30c', lim < 0.30), ('middle, 30-70c', (lim >= 0.30) & (lim < 0.70)), ('favourite, over 70c', lim >= 0.70),
                      ('7-14 min left', tau > 420), ('2.5-7 min left', tau <= 420), ('buying with the last minute\'s move', with_move), ('buying against it', against)):
        for name in ('through', 'queue', 'queue+'):
            ok, tf, sv = saving(name)
            ok = ok & mask
            fill, miss, cross = ok & posted & ~np.isnan(tf), ok & posted & np.isnan(tf), ok & ~posted
            rows_.append([lab, name, f'{int(ok.sum()):,}', f'{cross.sum() / max(1, ok.sum()) * 100:.0f}%', f'{fill.sum() / max(1, ok.sum()) * 100:.0f}%',
                          rng(boot(np.where(mask, sv, np.nan), g)), c(float(np.nanmean(np.where(fill, tc - lim, np.nan)))) if fill.any() else '—',
                          c(float(np.nanmean(np.where(miss, tc - late, np.nan)))) if miss.any() else '—'])
    md += ec.table(['orders', 'fill rule', 'decisions', 'crossed on arrival', 'filled while resting', 'saving per contract', 'saving when filled', 'saving when missed'], rows_)
    h2 = np.median(np.unique(close))
    _, _, sv = saving('queue')
    md += ['', f'Halves, queue rule: first {rng(boot(np.where(close < h2, sv, np.nan), g))}, second {rng(boot(np.where(close >= h2, sv, np.nan), g))}.']

    # halves
    half = np.median(np.unique(close))
    md += ['', '## 7. First and second half of the rounds (queue+ rule, 60-s markout)', '']
    rows_ = []
    tf = df['t_queue+'].to_numpy(); v = np.where(~np.isnan(tf), df['m60_queue+'].to_numpy() - lim, np.nan)
    for lab, mask in (('all', allm), ('favourite, over 70c', lim >= 0.70), ('longshot, under 30c', lim < 0.30)):
        a, b = boot(np.where(mask & (close < half), v, np.nan), g), boot(np.where(mask & (close >= half), v, np.nan), g)
        rows_.append([lab, rng(a), rng(b)])
    md += ec.table(['orders', 'first half', 'second half'], rows_)

    q0 = df['q0'].to_numpy()
    md += ['', '## Context', '',
           f'- {np.mean(~df["posted"].to_numpy()) * 100:.0f}% of bids priced from a {LATENCY_MS / 1000:.0f}-s-old snapshot would have crossed the ask on arrival. They are counted as takes, not as resting fills, and are left out of sections 1-4.',
           f'- Size already resting at the best bid when we join: median {np.median(q0):,.0f} contracts (10th percentile {np.percentile(q0, 10):,.0f}, 90th {np.percentile(q0, 90):,.0f}).',
           f'- The spread at placement was one tick on {np.mean(np.abs((df["mid_now"].to_numpy() - lim) * 2 - np.where((lim > 0.10) & (lim < 0.90), 0.01, 0.001)) < 2e-3) * 100:.0f}% of bids, so there is rarely room to step in front of the queue.',
           '- Limits: the journal\'s book is one snapshot a second and the engine\'s clock can be ~0.5 s off Kalshi\'s, hence the 1 s before an order counts as live. Queue position is inferred, not observed. '
           'One contract per order: no market impact. Fills in the last 2 minutes are not studied.']
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / args.out).write_text('\n'.join(md) + '\n', encoding='utf-8')
    if args.out == 'maker-study.md':
        df.write_parquet(ec.CACHE / 'maker_orders.parquet')
    sys.stdout.reconfigure(encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
