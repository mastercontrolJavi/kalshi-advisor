import type Database from 'better-sqlite3';
import type {StackSample} from './stack';
/** Training rows: every frozen opening/live call on a settled market, with its model probability, Kalshi mid and features. */
export function stackSamples(db:Database.Database):StackSample[]{
  const rows=db.prepare(`SELECT c.ticker,'open' AS horizon,c.mid,c.context,r.result FROM opening_calls c JOIN outcomes r USING(ticker)
    UNION ALL SELECT l.ticker,CAST(l.horizon AS TEXT),l.mid,l.context,r.result FROM live_calls l JOIN outcomes r USING(ticker)`).all() as {ticker:string;horizon:string;mid:number|null;context:string;result:string}[];
  const out:StackSample[]=[];
  for(const r of rows){
    if(r.result!=='yes'&&r.result!=='no')continue;
    const inputs=JSON.parse(r.context).inputs;if(!inputs||!Number.isFinite(inputs.modelP)||!(inputs.sigma>0))continue;
    out.push({modelP:inputs.modelP,mid:r.mid,sigma:inputs.sigma,momentum30s:inputs.momentum30s??null,momentum120s:inputs.momentum120s??null,imbalance:inputs.imbalance??null,tradeFlow30s:inputs.tradeFlow30s??null,tradeVolume30s:inputs.tradeVolume30s??null,y:r.result==='yes'?1:0,ticker:r.ticker,horizon:r.horizon});
  }
  return out;
}
