import type {SharpWallet} from './falcon';
/** Polymarket's public data API (no key): wallet positions, trades, leaderboards. Every request is a GET to this host only. */
export const PM_DATA='https://data-api.polymarket.com';
export type FetchJson=(url:string)=>Promise<any>;
export interface PmPosition {wallet:string;cond:string;outcome:string;outcomeIndex:number;title:string;eventSlug:string;size:number;avgPrice:number;curPrice:number;value:number;cost:number;endDate:string|null;redeemable:boolean}
export interface PmTrade {wallet:string;side:'BUY'|'SELL';outcome:string;size:number;price:number;time:number}
const num=(v:unknown,f=0)=>{const n=Number(v);return Number.isFinite(n)?n:f;};
export async function walletPositions(fetchJson:FetchJson,wallet:string):Promise<PmPosition[]>{
  const rows=await fetchJson(`${PM_DATA}/positions?user=${encodeURIComponent(wallet)}&limit=500&sizeThreshold=1&sortBy=CURRENT`);
  return (Array.isArray(rows)?rows:[]).map((p:any)=>({wallet:wallet.toLowerCase(),cond:String(p.conditionId??''),outcome:String(p.outcome??''),outcomeIndex:num(p.outcomeIndex,-1),title:String(p.title??''),eventSlug:String(p.eventSlug??''),
    size:num(p.size),avgPrice:num(p.avgPrice),curPrice:num(p.curPrice),value:num(p.currentValue),cost:num(p.initialValue),endDate:typeof p.endDate==='string'?p.endDate:null,redeemable:!!p.redeemable})).filter(p=>p.cond);
}
/** Top crypto traders by profit this week and this month (Polymarket's own leaderboard): the wallets that trade the 15-minute Bitcoin rounds. */
export async function cryptoLeaders(fetchJson:FetchJson,limit=50):Promise<SharpWallet[]>{
  const seen=new Map<string,SharpWallet>();
  for(const period of ['WEEK','MONTH']){const rows=await fetchJson(`${PM_DATA}/v1/leaderboard?category=CRYPTO&timePeriod=${period}&orderBy=PNL&limit=${limit}`);
    for(const r of Array.isArray(rows)?rows:[]){const a=String(r.proxyWallet??'').toLowerCase();if(!/^0x[0-9a-f]{40}$/.test(a)||seen.has(a))continue;
      seen.set(a,{address:a,rank:num(r.rank,seen.size+1),tier:`Crypto ${period.toLowerCase()}`,score:null,roi:null,winRate:null,sharpe:null,trades:null,markets:null,pnl:num(r.pnl),volume:num(r.vol),trajectory:null,source:'crypto',name:r.userName?String(r.userName):null});}}
  return [...seen.values()];
}
/** Trades in one market, newest first, up to `maxPages` × 500. */
export async function marketTrades(fetchJson:FetchJson,cond:string,maxPages=6):Promise<PmTrade[]>{
  const out:PmTrade[]=[];
  for(let page=0;page<maxPages;page++){const rows=await fetchJson(`${PM_DATA}/trades?market=${encodeURIComponent(cond)}&limit=500&offset=${page*500}`);if(!Array.isArray(rows))break;
    for(const t of rows)out.push({wallet:String(t.proxyWallet??'').toLowerCase(),side:t.side==='SELL'?'SELL':'BUY',outcome:String(t.outcome??''),size:num(t.size),price:num(t.price),time:num(t.timestamp)});
    if(rows.length<500)break;}
  return out;
}
