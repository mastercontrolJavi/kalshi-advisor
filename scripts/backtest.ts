import {HistoryStore,fetchMarkets15,fetchCandles,fetchSpot,SERIES15} from '../src/backtest/history';
import {KalshiClient} from '../src/engine/feeds/kalshi';
/**
 * npm run backtest -- [--days 90] [--skip-fetch] [--fetch-only] [--out docs/BACKTEST.md]
 * Downloads public history into data/history.db (resumable), then replays the app's model and entry/exit rules.
 */
const arg=(name:string,fallback:string)=>{const i=process.argv.indexOf('--'+name);return i>0&&process.argv[i+1]?process.argv[i+1]:fallback;};
const flag=(name:string)=>process.argv.includes('--'+name);
const days=Number(arg('days','90')),out=arg('out','docs/BACKTEST.md');
const log=(m:string)=>console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);
const store=new HistoryStore(),now=Math.floor(Date.now()/1000),to=Math.floor(now/900)*900-900,from=to-days*86400;
if(!flag('skip-fetch')){
  const client=new KalshiClient('','');
  log(`Fetching ${days} days of ${SERIES15} (to ${new Date(to*1000).toISOString()})`);
  await fetchMarkets15(store,client,from,to,log);
  log('Fetching Coinbase BTC-USD 1-minute candles');await fetchSpot(store,from-4*3600,to,log);
  await fetchCandles(store,client,SERIES15,log);
  log('Fetch complete');
}
if(!flag('fetch-only')){
  const {runBacktest}=await import('../src/backtest/report');
  const summary=runBacktest(store,{out,log});log(`Report written to ${out}`);console.log(summary);
}
