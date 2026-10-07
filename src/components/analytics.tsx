'use client';
import {useCallback,useEffect,useState,type ReactNode} from 'react';
import dynamic from 'next/dynamic';
import {RefreshCw,Check,X,Lightbulb} from 'lucide-react';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Button} from './ui/button';
import {Pill} from './panels';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,pct,cents,qty} from './format';
const Equity=dynamic(()=>import('./analytics-charts').then(m=>m.EquityChart),{ssr:false});
const Daily=dynamic(()=>import('./analytics-charts').then(m=>m.DailyChart),{ssr:false});
const Trend=dynamic(()=>import('./analytics-charts').then(m=>m.TrendChart),{ssr:false});
const REFRESH_MS=60000;
const tone=(v:number|null|undefined)=>v==null||v===0?'':v>0?'text-yes':'text-no';
function Kpi({label,children,sub,className}:{label:string;children:ReactNode;sub?:ReactNode;className?:string}){
  return <Card className="p-4"><div className="label">{label}</div><div className={cn('num mt-1.5 text-2xl font-medium',className)}>{children}</div>{sub?<div className="mt-0.5 text-xs text-muted">{sub}</div>:null}</Card>;
}
function Empty({children}:{children:ReactNode}){return <p className="rounded-xl border border-dashed border-line py-10 text-center text-sm text-muted">{children}</p>;}
function Breakdown({title,rows}:{title:string;rows:any[]}){
  return <Card><h2 className="mb-3 font-semibold">{title}</h2>{rows?.length?<table className="w-full text-sm"><thead className="text-left text-xs text-muted"><tr>{['','Markets','Win rate','P&L','Avg / market'].map(h=><th key={h} scope="col" className="pb-2 pr-2 font-medium">{h}</th>)}</tr></thead>
    <tbody>{rows.map(r=><tr key={r.bucket} className="border-t border-line"><th scope="row" className="py-2 pr-2 text-left font-medium">{r.bucket}</th><td className="num pr-2">{r.markets}</td><td className="num pr-2">{pct(r.winRate,0)}</td><td className={cn('num pr-2',tone(r.pnl))}>{signedDollars(r.pnl)}</td><td className={cn('num',tone(r.expectancy))}>{signedDollars(r.expectancy)}</td></tr>)}</tbody></table>:<Empty>No settled trades yet.</Empty>}</Card>;
}
/** Plain-English takeaways, only from buckets with enough markets to mean something. */
function insights(a:any):string[]{
  const out:string[]=[],min=3,ok=(r:any)=>r&&r.markets>=min;
  if(!a?.all?.markets)return out;
  const side=a.bySide.filter(ok);if(side.length===2){const [best,worst]=[...side].sort((x,y)=>y.expectancy-x.expectancy);if(best.expectancy-worst.expectancy>.1)out.push(`${best.bucket} trades average ${signedDollars(best.expectancy)} per market vs ${signedDollars(worst.expectancy)} on ${worst.bucket}.`);}
  const leak=a.byPrice.filter(ok).sort((x:any,y:any)=>x.expectancy-y.expectancy)[0];if(leak&&leak.expectancy<0)out.push(`Entries at ${leak.bucket} are your biggest leak: ${signedDollars(leak.pnl)} over ${leak.markets} markets.`);
  const follow=a.byFollow.find((r:any)=>r.bucket==='Advisor idea'),own=a.byFollow.find((r:any)=>r.bucket==='Own call');
  if(ok(follow)&&ok(own))out.push(`Trades matching an advisor idea average ${signedDollars(follow.expectancy)} per market; your own calls average ${signedDollars(own.expectancy)}.`);
  else if(ok(own)&&!follow)out.push('None of your trades so far followed an advisor idea within 3 minutes — the paper results on the Calibration page are the fair test of the signals.');
  const hold=a.byExit.filter(ok);if(hold.length===2){const h=hold.find((r:any)=>r.bucket==='Held to settlement'),s=hold.find((r:any)=>r.bucket==='Sold before close');if(h&&s)out.push(`Held to settlement: ${signedDollars(h.expectancy)} per market; sold early: ${signedDollars(s.expectancy)}.`);}
  if(a.all.profitFactor!=null)out.push(a.all.profitFactor>=1?`Profit factor ${a.all.profitFactor.toFixed(2)}: winners outweigh losers.`:`Profit factor ${a.all.profitFactor.toFixed(2)}: losses outweigh wins — average loss ${signedDollars(a.all.avgLoss)} vs average win ${signedDollars(a.all.avgWin)}.`);
  const r=a.rolling;if(r?.length>=20){const now=r.at(-1),before=r.at(-11);if(now?.avgPnl!=null&&before?.avgPnl!=null)out.push(`Trend: your last-10-market average is ${signedDollars(now.avgPnl)} vs ${signedDollars(before.avgPnl)} ten markets ago.`);}
  return out;
}
export default function Analytics(){
  const [a,setA]=useState<any>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const load=useCallback(async()=>{setLoading(true);try{const r=await fetch('/api/engine/analytics',{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);setA(await r.json());setError('');}catch(e){setError((e as Error).message);}finally{setLoading(false);}},[]);
  // Historical page: refresh once a minute (the live dashboard itself is pushed over WebSocket).
  useEffect(()=>{void load();const t=setInterval(()=>void load(),REFRESH_MS);return()=>clearInterval(t);},[load]);
  const all=a?.all,tips=insights(a);
  return <>
    <SiteHeader current="/analytics"><Button variant="ghost" size="sm" onClick={()=>void load()} disabled={loading} aria-label="Refresh analytics"><RefreshCw aria-hidden className={cn('size-4',loading&&'animate-spin')}/>{a?new Date(a.updated).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'—'}</Button></SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      <Card className="rise"><div className="flex flex-wrap items-center gap-3"><h1 className="font-display text-4xl font-bold">Your performance</h1>{a?.account?.ready?<Pill tone="yes">Kalshi synced</Pill>:<Pill tone="warn">Account not synced</Pill>}{error?<Pill tone="no">{error}</Pill>:null}</div>
        <p className="mt-2 max-w-4xl text-sm text-muted">Real KXBTC15M fills and settlements from your Kalshi account, net of actual fees. One row per market; a market counts as a win when its net P&L is positive. {a?.open?`${a.open} market${a.open>1?'s':''} still open.`:''}</p></Card>
      {!a?<Empty>{error?`Could not load analytics: ${error}`:'Loading your Kalshi history…'}</Empty>:<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Total P&L" className={tone(all.pnl)} sub={`${all.markets} markets`}>{signedDollars(all.pnl)}</Kpi>
        <Kpi label="Today" className={tone(a.today.pnl)} sub={`${a.today.markets} markets · ${pct(a.today.winRate,0)} won`}>{signedDollars(a.today.pnl)}</Kpi>
        <Kpi label="Last 7 days" className={tone(a.week.pnl)} sub={`${a.week.markets} markets`}>{signedDollars(a.week.pnl)}</Kpi>
        <Kpi label="Win rate" sub={`${all.wins} won · ${all.losses} lost`}>{pct(all.winRate)}</Kpi>
        <Kpi label="Money won / lost" sub={<><span className="text-yes">{dollars(all.won)}</span> / <span className="text-no">{dollars(all.lost)}</span></>}>{all.profitFactor!=null?all.profitFactor.toFixed(2):'—'}<span className="ml-1 text-xs text-muted">profit factor</span></Kpi>
        <Kpi label="Avg per market" className={tone(all.expectancy)} sub={`win ${signedDollars(all.avgWin)} · loss ${signedDollars(all.avgLoss)}`}>{signedDollars(all.expectancy)}</Kpi>
        <Kpi label="Max drawdown" className="text-no" sub="peak-to-trough, realized">{signedDollars(-a.maxDrawdown)}</Kpi>
        <Kpi label="Fees paid" sub={`${dollars(all.fees&&all.markets?all.fees/all.markets:0)} per market`}>{dollars(all.fees)}</Kpi>
        <Kpi label="Streak" className={tone(a.streak)} sub={`best +${a.bestRun} · worst ${a.worstRun}`}>{a.streak>0?`+${a.streak}`:a.streak}</Kpi>
        <Kpi label="Avg size" sub={`avg entry ${cents(all.avgEntry)}`}>{qty(all.avgContracts)}<span className="ml-1 text-xs text-muted">contracts</span></Kpi>
        <Kpi label="Best market" className="text-yes" sub={a.best?.ticker?.slice(-13)}>{signedDollars(a.best?.pnl)}</Kpi>
        <Kpi label="Worst market" className="text-no" sub={a.worst?.ticker?.slice(-13)}>{signedDollars(a.worst?.pnl)}</Kpi>
      </div>
      {tips.length?<Card className="border-info/30"><h2 className="mb-3 flex items-center gap-2 font-semibold"><Lightbulb aria-hidden className="size-4 text-info"/>What your history says</h2><ul className="space-y-2 text-sm">{tips.map(t=><li key={t} className="flex gap-2"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-info"/>{t}</li>)}</ul><p className="mt-3 text-xs text-faint">Only buckets with 3+ markets are summarised; small samples are noisy.</p></Card>:null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><h2 className="mb-4 font-semibold">Cumulative P&L</h2>{a.curve.length?<Equity data={a.curve}/>:<Empty>No settled markets yet.</Empty>}</Card>
        <Card><h2 className="mb-1 font-semibold">Average trend</h2><p className="mb-3 text-xs text-muted">Rolling last-10-market average P&L and win rate.</p>{a.rolling.length?<Trend data={a.rolling}/>:<Empty>Needs settled markets.</Empty>}</Card>
      </div>
      <Card><h2 className="mb-4 font-semibold">P&L by day</h2>{a.daily.length?<Daily data={a.daily}/>:<Empty>No settled markets yet.</Empty>}</Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Breakdown title="By side" rows={a.bySide}/><Breakdown title="By entry price" rows={a.byPrice}/><Breakdown title="By time of day" rows={a.byHour}/>
        <Breakdown title="Advisor idea vs own call" rows={a.byFollow}/><Breakdown title="Held vs sold early" rows={a.byExit}/>
        <Card><h2 className="mb-3 font-semibold">Account</h2><dl className="grid grid-cols-2 gap-y-2 text-sm"><dt className="text-muted">Cash balance</dt><dd className="num text-right">{dollars(a.account?.balance)}</dd><dt className="text-muted">Open positions value</dt><dd className="num text-right">{dollars(a.account?.portfolio)}</dd><dt className="text-muted">Last 30 days</dt><dd className={cn('num text-right',tone(a.month.pnl))}>{signedDollars(a.month.pnl)}</dd><dt className="text-muted">Balance snapshots</dt><dd className="num text-right">{a.balances.length}</dd></dl></Card>
      </div>
      <Card><h2 className="mb-3 font-semibold">Trade history</h2>{a.recent.length?<div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['When','Market','Side','Contracts','Avg entry','Fees','P&L','Exit','Advisor idea'].map(h=><th key={h} scope="col" className="pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{a.recent.map((m:any)=><tr key={m.ticker} className="border-t border-line"><td className="py-2 pr-3 text-muted">{new Date(m.first).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</td><td className="num pr-3 text-xs">{m.ticker.replace('KXBTC15M-','')}</td>
          <td className={cn('pr-3 font-medium',m.side==='yes'?'text-yes':'text-no')}>{m.side.toUpperCase()}</td><td className="num pr-3">{qty(m.contracts)}</td><td className="num pr-3">{cents(m.avgEntry)}</td><td className="num pr-3 text-muted">{dollars(m.fees)}</td>
          <td className={cn('num pr-3',tone(m.pnl))}>{m.status==='open'?<span className="text-muted">open</span>:signedDollars(m.pnl)}</td><td className="pr-3 text-muted">{m.exitedEarly?'sold early':m.status==='open'?'—':'held'}</td><td>{m.followed?<Check aria-label="yes" className="size-4 text-yes"/>:<X aria-label="no" className="size-4 text-faint"/>}</td></tr>)}</tbody></table></div>:<Empty>No trades found in your Kalshi history.</Empty>}</Card>
      </>}
    </main>
  </>;
}
