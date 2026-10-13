import type Database from 'better-sqlite3';
import type {Sample} from '../model/math';
import {forecastPrice,PRICE_HORIZONS,priceInputs,priceScores,type PriceFit,type PricePrediction,type PriceScore} from './price-forecast';

export const PRICE_FORECAST_SCHEMA=`CREATE TABLE IF NOT EXISTS price_forecasts(time INTEGER NOT NULL,horizon INTEGER NOT NULL,target_time INTEGER NOT NULL,spot REAL NOT NULL,p_up REAL NOT NULL,direction TEXT NOT NULL,low REAL NOT NULL,high REAL NOT NULL,expected REAL NOT NULL,active INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',actual REAL,actual_time INTEGER,context TEXT NOT NULL,PRIMARY KEY(time,horizon));
  CREATE INDEX IF NOT EXISTS price_forecasts_pending ON price_forecasts(status,target_time);
  CREATE INDEX IF NOT EXISTS price_forecasts_horizon ON price_forecasts(horizon,time);`;
export class PriceForecastJournal {
  private pending:Database.Statement;private insert:Database.Statement;private resolve:Database.Statement;
  constructor(private db:Database.Database){
    db.exec(PRICE_FORECAST_SCHEMA);
    this.pending=db.prepare("SELECT time,horizon,target_time,context FROM price_forecasts WHERE status='pending' AND target_time<=?");
    this.insert=db.prepare('INSERT OR IGNORE INTO price_forecasts(time,horizon,target_time,spot,p_up,direction,low,high,expected,active,context) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    this.resolve=db.prepare("UPDATE price_forecasts SET status=?,actual=?,actual_time=? WHERE time=? AND horizon=? AND status='pending'");
  }
  /** Fixed checkpoints give non-overlapping forward targets per horizon. Forecasts are immutable. */
  capture(time:number,inputs:NonNullable<ReturnType<typeof priceInputs>>,fits:PriceFit[]){
    for(const fit of fits)if(time%(fit.horizon*1000)===0){const p=forecastPrice(inputs,fit,time);this.insert.run(time,fit.horizon,p.targetTime,p.spot,p.pUp,p.direction,p.low,p.high,p.expected,p.active?1:0,JSON.stringify({prediction:p,inputs}));}
  }
  /** No forward-fill or interpolation at the outcome. Late restarts and unhealthy endpoints are excluded. */
  settle(samples:Sample[],time:number,healthy:boolean){
    const map=new Map(samples.slice(-190).map(s=>[s.time,s.price]));
    for(const r of this.pending.all(time) as {time:number;horizon:number;target_time:number;context:string}[]){
      const actual=map.get(r.target_time);
      if(time>r.target_time+2000){this.resolve.run('missing',null,null,r.time,r.horizon);continue;}
      if(healthy&&actual!==undefined&&actual>0&&Number.isFinite(actual)){const p=JSON.parse(r.context).prediction as PricePrediction;this.resolve.run(actual===p.spot?'flat':'scored',actual,r.target_time,r.time,r.horizon);}
      else if(time===r.target_time+2000)this.resolve.run('missing',null,null,r.time,r.horizon);
    }
  }
  scores(){return readPriceScores(this.db);}
}
export function readPriceScores(db:Database.Database):Record<number,PriceScore&{flat:number;missing:number;pending:number}>{
    const out:Record<number,PriceScore&{flat:number;missing:number;pending:number}>={};
    for(const h of PRICE_HORIZONS){const rows=db.prepare('SELECT p_up,direction,actual,status,context FROM price_forecasts WHERE horizon=? ORDER BY time DESC LIMIT 2000').all(h) as {p_up:number;direction:PricePrediction['direction'];actual:number|null;status:string;context:string}[];
      const resolved=rows.filter(r=>r.status==='scored'||r.status==='flat').map(r=>{const {prediction:p,inputs}=JSON.parse(r.context),scale=inputs.sigma*Math.sqrt(h);return {time:p.time,p:r.p_up,z:Math.log(r.actual!/p.spot)/scale,mean:p.logMove/scale,noise:p.logSD/scale,direction:r.direction};});
      out[h]={...priceScores(resolved),flat:rows.filter(r=>r.status==='flat').length,missing:rows.filter(r=>r.status==='missing').length,pending:rows.filter(r=>r.status==='pending').length};
    }return out;
  }
