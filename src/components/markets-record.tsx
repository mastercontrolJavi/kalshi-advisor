'use client';
import {useCallback,useEffect,useState} from 'react';
import dynamic from 'next/dynamic';
import {Info} from 'lucide-react';
import {useLive} from './use-live';
import {useSoundAlerts} from './use-sound-alerts';
import {SoundToggle} from './sound-panel';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Pill,Kpi,Empty} from './panels';
import {MarketsNav,useMarketsFilter} from './markets-nav';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,pct} from './format';
const Reliability=dynamic(()=>import('./calibration-charts').then(m=>m.ReliabilityChart),{ssr:false});
const REFRESH_MS=60000;
const groupLabel:Record<string,string>={sports:'Sports',combos:'Combos',politics:'Politics & econ',commodities:'Commodities & crypto'};
const HORIZONS:[string,string][]=[['p1','1 h before'],['p24','24 h before'],['vwap','Average traded']];
const tone=(v:number|null|undefined)=>v==null||v===0?'':v>0?'text-yes':'text-no';
const band=(lo:number,hi:number)=>`${Math.round(lo*100)}–${Math.round(hi*100)}¢`;
const range=(lo:number|null,hi:number|null,f:(v:number)=>string)=>lo==null||hi==null?'—':`${f(lo)} to ${f(hi)}`;
const signedPct=(v:number|null|undefined,d=0)=>v==null||!Number.isFinite(v)?'—':`${v>0?'+':v<0?'−':''}${Math.abs(v*100).toFixed(d)}%`;
const day=(t:number|null)=>t?new Date(t*1000).toLocaleDateString([],{month:'short',day:'numeric'}):'—';
/** Settled results: P&L, win rate and return on money spent per row. */
function RecordTable({title,rows,first}:{title:string;rows:any[];first:string}){
  return <Card><h2 className="mb-3 font-semibold">{title}</h2>{rows.some(r=>r.markets)?<table className="w-full text-sm"><thead className="text-left text-xs text-muted"><tr>{[first,'Markets','Win rate','P&L','Return'].map(h=><th key={h} scope="col" className="pb-2 pr-2 font-medium">{h}</th>)}</tr></thead>
    <tbody>{rows.map(r=><tr key={r.bucket} className="border-t border-line"><th scope="row" className="py-2 pr-2 text-left font-medium">{groupLabel[r.bucket]??r.bucket}</th><td className="num pr-2">{r.markets}</td><td className="num pr-2">{pct(r.winRate,0)}</td><td className={cn('num pr-2',tone(r.pnl))}>{signedDollars(r.pnl)}</td><td className={cn('num',tone(r.ret))}>{signedPct(r.ret)}</td></tr>)}</tbody></table>:<Empty>No settled markets here yet.</Empty>}</Card>;
}
/** Markets → Record: your own results outside Bitcoin, and how accurate Kalshi's prices were (public history). */
export default function MarketsRecord(){
  const m=useLive('/markets-ws'),sound=useSoundAlerts(null,false,'markets',{state:m.state,fresh:m.fresh});
  const [filter,setFilter]=useMarketsFilter(),[h,setH]=useState('p1');
  const [r,setR]=useState<any>(null),[error,setError]=useState('');
  const load=useCallback(async()=>{try{const res=await fetch('/api/markets/record',{cache:'no-store'});if(!res.ok)throw new Error(`HTTP ${res.status}`);setR(await res.json());setError('');}catch(e){setError((e as Error).message);}},[]);
  // Historical page: refresh once a minute, like Analytics.
  useEffect(()=>{void load();const t=setInterval(()=>void load(),REFRESH_MS);return()=>clearInterval(t);},[load]);
  const y=r?.yours,line=filter==='all'?y?.total:y?.byGroup.find((x:any)=>x.bucket===filter)??{markets:0,wins:0,winRate:null,pnl:0,spent:0,ret:null};
  const groups=filter==='all'?y?.byGroup??[]:(y?.byGroup??[]).filter((x:any)=>x.bucket===filter),entry=filter==='all'?y?.byEntry??[]:y?.entryBy?.[filter]??[];
  const buckets:any[]=filter==='combos'?[]:r?.accuracy?.[filter]?.[h]??[],shown=buckets.filter(b=>b.n>0),bf=r?.backfill;
  return <>
    <div aria-hidden className="ambient" data-tone={!m.fresh?'warn':'none'}/>
    <SiteHeader current="/markets">
      <SoundToggle prefs={sound.prefs} setPrefs={sound.setPrefs} ready={sound.ready}/>
      <Pill tone={m.fresh?'yes':'warn'}><span className={m.fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{m.fresh?'Live':m.connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      <MarketsNav current="record" filter={filter} setFilter={setFilter}/>
      {error?<p className="text-xs text-warn">Could not load the record: {error}</p>:null}
      {!r?<Empty>{error?'The markets engine is unavailable; this page retries every minute.':'Loading your record…'}</Empty>:<>
      <Card className="rise"><h2 className="font-semibold">Your record outside Bitcoin</h2><p className="mt-1 max-w-4xl text-sm text-muted">Settled markets from your Kalshi account, net of the fees you paid. A market counts as a win when its net P&L is positive; return is P&L over what you spent on entries and fees.</p></Card>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Settled markets" sub={filter==='all'?'all categories':groupLabel[filter]}>{line.markets}</Kpi>
        <Kpi label="Win rate" sub={`${line.wins} won · ${line.markets-line.wins} lost`}>{pct(line.winRate,0)}</Kpi>
        <Kpi label="P&L" className={tone(line.pnl)} sub="net of fees">{signedDollars(line.pnl)}</Kpi>
        <Kpi label="Return" className={tone(line.ret)} sub={`on ${dollars(line.spent)} spent`}>{signedPct(line.ret)}</Kpi>
      </div>
      <div className="grid gap-4 md:grid-cols-2"><RecordTable title="By category" rows={groups} first="Category"/><RecordTable title="By entry price" rows={entry} first="Paid"/></div>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">How accurate Kalshi&apos;s prices were</h2>
          <nav aria-label="When the price was taken" className="flex flex-wrap gap-1">{HORIZONS.map(([k,l])=><button key={k} type="button" aria-pressed={h===k} onClick={()=>setH(k)}
            className={cn('inline-flex min-h-10 cursor-pointer items-center rounded-xl px-3 text-sm transition-colors',h===k?'bg-surface-2 text-fg':'text-muted hover:text-fg')}>{l}</button>)}</nav></div>
        <p className="mt-1 max-w-4xl text-sm text-muted">Settled Kalshi markets{filter!=='all'&&filter!=='combos'?` in ${groupLabel[filter]}`:''}, grouped by their YES price {h==='p1'?'1 hour before the game or event':h==='p24'?'24 hours before the game or event':'averaged over the 24 hours before it, weighted by volume'}. If prices are accurate, contracts priced at 30¢ win about 30% of the time.</p>
        {filter==='combos'?<div className="mt-4"><Empty>Combos almost never trade publicly on Kalshi, so there is no price history to score. Your own combo results are above.</Empty></div>
        :!shown.length?<div className="mt-4"><Empty>{bf?.priced?'No settled market in this category had a tradable price at this time.':bf?.markets?`History is downloading: ${bf.markets.toLocaleString()} settled markets found, prices still being fetched.`:'History is still loading: the first download starts about 10 minutes after the app starts and takes a few minutes.'}</Empty></div>:<>
        <div className="mt-4"><Reliability data={shown.map(b=>({bucket:band(b.lo,b.hi),predicted:b.price,actual:b.win}))}/></div>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Priced at','Markets','Events','Priced avg','Won (95% range)','Gap','Return per $1 (95% range)'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
          <tbody>{shown.map(b=>{const gap=b.win-b.price,sure=b.low!=null&&b.high!=null&&(b.low>b.price||b.high<b.price),retSure=b.retLow!=null&&b.retHigh!=null&&(b.retLow>0||b.retHigh<0);
            return <tr key={b.lo} className="border-t border-line"><th scope="row" className="py-2 pr-3 text-left font-medium">{band(b.lo,b.hi)}</th><td className="num pr-3">{b.n}</td><td className="num pr-3 text-muted">{b.events}</td><td className="num pr-3">{pct(b.price,1)}</td>
              <td className="num pr-3">{pct(b.win,1)} <span className="text-xs text-muted">({range(b.low,b.high,v=>pct(v,0))})</span></td><td className={cn('num pr-3',sure?tone(gap):'text-muted')}>{signedPct(gap,1)}</td>
              <td className={cn('num',retSure?tone(b.ret):'')}>{signedPct(b.ret,1)} <span className="text-xs text-muted">({range(b.retLow,b.retHigh,v=>signedPct(v))})</span></td></tr>;})}</tbody></table></div>
        <p className="mt-3 text-xs text-faint">Gap = won minus priced; coloured only when the 95% range excludes the price. Return buys one YES contract at the ask (the average traded price for “Average traded”) and pays Kalshi&apos;s taker fee; coloured only when its range excludes zero. Ranges resample whole events, so both sides of one game count once.</p></>}
        {bf?<p className="mt-3 text-xs text-muted">{bf.priced.toLocaleString()} of {bf.markets.toLocaleString()} markets priced · settled {day(bf.from)} – {day(bf.to)} · {bf.finished?`updated ${new Date(bf.finished).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`:r.refreshing?'first download in progress':'not downloaded yet'}{r.refreshing&&bf.finished?' · updating now':''}</p>:null}
      </Card>
      <Card className="flex items-start gap-3 text-xs text-muted"><Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info"/><span>Kalshi history comes from its public data for the most-traded series in each category plus every series you have traded, settled since Kalshi&apos;s archive cutoff, and it is updated daily in the background. Markets with fewer than 100 contracts traded are left out. Past accuracy does not promise future results; these are measurements, not recommendations.</span></Card>
      </>}
    </main>
  </>;
}
