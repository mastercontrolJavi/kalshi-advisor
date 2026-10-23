/**
 * Dashboard stream fields that change at most once a second: sent with the once-a-second update only, and kept by the
 * page between updates (components/live-state.ts). The other three quarter-second updates carry only what moves faster
 * (book, forecast, evaluation, exits). Measured 2026-10-21: ~240 KB/s per dashboard tab before, most of it these.
 * No Node imports: the page reads this list too.
 */
export const SLOW_FIELDS=['backtest','backtestRefresh','mySetups','hourly','config','realWarnings','shortTerm','research'] as const;
