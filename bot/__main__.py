"""python -m bot run | status | reset | backtest   (run from the repo root; see bot/README.md)"""
from __future__ import annotations

import asyncio
import math
import sys
from datetime import datetime

from .config import load_config


def status() -> None:
    from .paper import PaperBroker
    cfg = load_config()
    b = PaperBroker(cfg.DB_PATH, cfg.START_BANKROLL)
    s = b.summary()
    print(f"Paper account since {datetime.fromtimestamp(s['started']):%Y-%m-%d %H:%M}")
    print(f"  equity   ${s['equity']:.2f}  (start ${s['start']:.2f}, peak ${s['peak']:.2f}, goal ${cfg.TARGET:.0f})")
    print(f"  rounds   {s['rounds']} settled, {s['wins']} won, {s['open']} open, {s['misses']} orders missed (ask moved before the fill)")
    if s['rounds']:
        ci = '' if math.isnan(s['per_contract_ci']) else f" (95% {100 * (s['per_contract'] - s['per_contract_ci']):+.1f}..{100 * (s['per_contract'] + s['per_contract_ci']):+.1f}c)"
        print(f"  result   ${s['pnl']:+.2f} after ${s['fees']:.2f} fees; {100 * s['per_contract']:+.2f}c a contract{ci}")
        print(f"  entries  average price {100 * s['avg_price']:.1f}c, average model edge {100 * s['avg_edge']:+.1f}c")
    for ts, ticker, side, n, price, pnl in b.db.execute('SELECT ts, ticker, side, contracts, price, pnl FROM fills ORDER BY id DESC LIMIT 10'):
        print(f"  {datetime.fromtimestamp(ts):%m-%d %H:%M:%S}  {ticker}  {side.upper():3} {n:g} @ {100 * price:.1f}c  " + ('open' if pnl is None else f'${pnl:+.2f}'))


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if cmd == 'run':
        from .runner import Bot
        try:
            asyncio.run(Bot(load_config()).run())
        except KeyboardInterrupt:
            pass
    elif cmd == 'status':
        status()
    elif cmd == 'reset':
        from .paper import PaperBroker
        cfg = load_config()
        PaperBroker(cfg.DB_PATH, cfg.START_BANKROLL).reset(cfg.START_BANKROLL)
        print(f'Paper account reset to ${cfg.START_BANKROLL:.2f}. Restart the bot if it is running.')
    elif cmd == 'backtest':
        from .backtest import main as backtest
        backtest(sys.argv[2:])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main()
