import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import {KalshiClient} from '../src/engine/feeds/kalshi';
import {MarketsJournal} from '../src/markets/journal';
import {runBackfill} from '../src/markets/fetch-backfill';
import {isBitcoin,seriesOf} from '../src/markets/categories';
/**
 * npm run markets-backfill: settled non-Bitcoin markets for the Markets → Record tab, into data/markets.db. Public data
 * only (no credentials), ≤ 5 requests/s, resumable. The markets process also runs this daily at low priority.
 */
const log=(m:string)=>console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);
const journal=new MarketsJournal(),started=Date.now();
const traded=new Set(journal.raw().fills.map((f:any)=>String(f.ticker??f.market_ticker)).filter(t=>!isBitcoin(t)&&!t.startsWith('KXMVE')).map(seriesOf));
try{const r=await runBackfill(new KalshiClient('','',200),journal,{now:Math.floor(Date.now()/1000),traded,log});log(`finished in ${Math.round((Date.now()-started)/1000)} s: ${JSON.stringify(r)} · ${JSON.stringify(journal.backfillStats())}`);}
finally{journal.db.close();}
