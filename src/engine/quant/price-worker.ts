import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3';
import {fitPrice,priceTraining,PRICE_HORIZONS} from './price-forecast';
import type {Sample} from '../model/math';
import {readPriceScores} from './price-journal';

// Read-only connection and bounded history; fitting never blocks the live quote loop.
const db=new Database(workerData.path,{readonly:true});db.pragma('busy_timeout = 2000');
let fitted=0;
parentPort!.on('message',()=>{
  try{const now=Date.now();let fits=null;
    if(now-fitted>=300000){const rows=db.prepare('SELECT time,proxy AS price FROM ticks INDEXED BY ticks_time WHERE time>=? AND proxy>0 ORDER BY time DESC LIMIT 100000').all(now-7*86400000) as Sample[];
      rows.reverse();fits=PRICE_HORIZONS.map(h=>fitPrice(priceTraining(rows,h),h,now));fitted=now;}
    parentPort!.postMessage({fits,scores:readPriceScores(db)});
  }catch(e){parentPort!.postMessage({error:(e as Error).message});}
});
