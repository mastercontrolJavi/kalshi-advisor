import type {MarketRow,CandleRow} from './history';
import {spotAt,quote,clusterCI,type SpotSeries} from './sim';
import {fee} from '../engine/model/fees';
import {classifySetup,SETUP_WINDOWS,SETUPS_FOUND,type SetupKind,type SetupRecord,type SetupStats} from './setups';
/**
 * How each chart setup paid on past rounds, per time-left window: the first minute of each round that shows the setup,
 * buy the side BTC is on (`with`) or the other side (`against`) at the candle's closing ask, hold to settlement, after
 * the taker fee. One trade per round per cell, so the 95% ranges are honest. Spot is Coinbase corrected to BRTI by the
 * same basis track the replay uses; the target is Kalshi's published K.
 */
export function setupStats(markets:MarketRow[],candles:Map<string,CandleRow[]>,s:SpotSeries,basisAt:(ts:number)=>number|null):SetupStats[]{
  const cells=new Map<string,{with:{t:number;pnl:number;win:boolean;price:number}[];against:{t:number;pnl:number;win:boolean;price:number}[]}>();
  const ms=markets.filter(m=>m.strike!==null&&(m.result==='yes'||m.result==='no'));
  for(const m of ms){
    const cs=candles.get(m.ticker);if(!cs)continue;const by=new Map(cs.map(c=>[c.ts,c])),seen=new Set<string>(),y=m.result==='yes';
    for(let tau=900;tau>=120;tau-=60){
      const ts=m.close_ts-tau,c=by.get(ts);if(!c)continue;const q=quote(c);if(q.bid===null||q.ask===null)continue;
      const now=spotAt(s,ts),b1=spotAt(s,ts-60),basis=basisAt(ts);if(!now||basis===null)continue;
      const st=classifySetup({tau,spot:now.price+basis,k:m.strike!,sigma:now.sigma,spot60:b1?b1.price+basis:null});if(!st?.window)continue;
      const key=`${st.window}|${st.kind}`;if(seen.has(key))continue;seen.add(key);
      const cell=cells.get(key)??{with:[],against:[]};cells.set(key,cell);
      for(const [which,side] of [['with',st.side],['against',st.side==='yes'?'no':'yes']] as const){
        const price=side==='yes'?q.ask:1-q.bid;if(price<=.01||price>=.99)continue;const win=(side==='yes')===y;
        cell[which].push({t:m.open_ts,pnl:(win?1:0)-price-fee(price),win,price});
      }
    }
  }
  const mid=(rounds:MarketRow[])=>rounds.length?rounds[Math.floor(rounds.length/2)].open_ts:0,newer=ms.filter(m=>m.open_ts>=SETUPS_FOUND);
  const split=mid(ms),splitAfter=mid(newer);
  type Trade={t:number;pnl:number;win:boolean;price:number};
  const base=(xs:Trade[],at:number):Omit<SetupRecord,'after'>|null=>{
    if(xs.length<2)return null;const avg=(a:typeof xs)=>a.length?a.reduce((q,x)=>q+x.pnl,0)/a.length:0;
    return {n:xs.length,mean:avg(xs),ci:clusterCI(xs.map(x=>({sum:x.pnl,n:1}))),early:avg(xs.filter(x=>x.t<at)),late:avg(xs.filter(x=>x.t>=at)),
      win:xs.filter(x=>x.win).length/xs.length,paid:xs.reduce((q,x)=>q+x.price,0)/xs.length};
  };
  // after: the rounds since the setups were picked out, judged on their own (SETUPS_FOUND), with their own halves.
  const rec=(xs:Trade[]):SetupRecord|null=>{const all=base(xs,split);return all&&{...all,after:base(xs.filter(x=>x.t>=SETUPS_FOUND),splitAfter)};};
  const kinds:SetupKind[]=['coinflip','dip','strong','trend'];
  return SETUP_WINDOWS.flatMap(w=>kinds.map(kind=>{const cell=cells.get(`${w.key}|${kind}`);return {window:w.key,kind,with:cell?rec(cell.with):null,against:cell?rec(cell.against):null};}));
}
