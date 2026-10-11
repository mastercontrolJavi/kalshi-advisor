/**
 * Falcon (Polymarket Analytics' API, FALCON_API_KEY in .env.local): parameterised queries against named "agents". The key goes
 * to this host only. Used for one thing the free Polymarket API lacks: a trader ranking that filters out bots, wash
 * traders and lucky streaks (agent 584, Heisenberg score over a rolling 15 days). Limit seen 2026-10-10: 50 requests/s.
 */
export const FALCON_HOST='https://retriever.falconapi.net';
export const FALCON_PATH='/api/v2/semantic/retrieve/parameterized';
export type FalconPost=(agentId:number,params:Record<string,string>,limit:number,offset?:number)=>Promise<any[]>;
export interface SharpWallet {address:string;rank:number;tier:string;score:number|null;roi:number|null;winRate:number|null;sharpe:number|null;trades:number|null;markets:number|null;pnl:number|null;volume:number|null;trajectory:string|null;source:'falcon'|'crypto';name:string|null}
const num=(v:unknown)=>{const n=Number(v);return v===undefined||v===null||v===''||!Number.isFinite(n)?null:n;};
export function falconClient(key:string,fetchImpl:typeof fetch=fetch):FalconPost{
  return async(agentId,params,limit,offset=0)=>{
    const r=await fetchImpl(FALCON_HOST+FALCON_PATH,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({agent_id:agentId,params,pagination:{limit,offset},formatter_config:{format_type:'raw'}})});
    if(r.status===401||r.status===403)throw new Error('Falcon key rejected');if(!r.ok)throw new Error(`Falcon HTTP ${r.status}`);
    const j:any=await r.json();return Array.isArray(j?.data?.results)?j.data.results:[];
  };
}
/** Agent 584: the best Polymarket traders over the last 15 days (≥ 50 trades, win rate 45–95%), Heisenberg score first. */
export async function sharpLeaderboard(post:FalconPost,limit=100):Promise<SharpWallet[]>{
  const rows=await post(584,{min_roi_15d:'0',min_win_rate_15d:'0.45',max_win_rate_15d:'0.95',min_total_trades_15d:'50',max_total_trades_15d:'100000',min_pnl_15d:'0',sort_by:'h_score'},limit);
  return rows.filter(r=>typeof r.wallet==='string'&&/^0x[0-9a-fA-F]{40}$/.test(r.wallet)).map((r,i)=>({address:r.wallet.toLowerCase(),rank:num(r.leaderboard_rank)??i+1,tier:String(r.tier??''),score:num(r.h_score),
    roi:num(r.roi_pct_15d)!==null?num(r.roi_pct_15d)!/100:null,winRate:num(r.win_rate_pct_15d)!==null?num(r.win_rate_pct_15d)!/100:null,sharpe:num(r.sharpe_ratio_15d),trades:num(r.total_trades_15d),
    markets:num(r.markets_traded_15d),pnl:num(r.total_pnl_15d),volume:num(r.total_volume_15d),trajectory:r.trajectory??null,source:'falcon' as const,name:null}));
}
