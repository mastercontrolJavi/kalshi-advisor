'use client';
import {Check,X,Clock,Layers,History,Wallet,Info} from 'lucide-react';
import {useLive} from './use-live';
import {useSoundAlerts} from './use-sound-alerts';
import {SoundToggle} from './sound-panel';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Pill,ProbBar,Collapsible,BacktestNote,type Tone} from './panels';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,cents,signedCents,pct,qty,mmss,opensAt,maintenanceNote} from './format';
const et=(t:number|null|undefined)=>t?new Date(t).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'})+' ET':'—';
const local=(t:number|null|undefined)=>t?new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'—';
const hm=(sec:number)=>sec>=3600?`${Math.floor(sec/3600)}:${mmss(sec%3600)}`:mmss(sec);
const HORIZONS:[string,string][]=[['2700','45m'],['1800','30m'],['900','15m'],['300','5m'],['60','1m']];
function Kpi({label,children,sub,tone}:{label:string;children:React.ReactNode;sub?:React.ReactNode;tone?:string}){return <div className="min-w-0"><div className="label">{label}</div><div className={cn('num mt-1.5 text-xl sm:text-2xl',tone)}>{children}</div>{sub?<div className="mt-0.5 truncate text-xs text-muted">{sub}</div>:null}</div>;}
export default function Hourly(){
  const {state:s,connected,fresh}=useLive(),markets=useLive('/markets-ws'),h=fresh?s?.hourly:null,up=h?.up,best=h?.ideas?.[0],sound=useSoundAlerts(s,fresh,'hourly',{state:markets.state,fresh:markets.fresh});
  const tone:Tone=best?(best.side==='yes'?'yes':'no'):'neutral';
  const spotStrike=h?.rungs?.length&&h.spot!=null?h.rungs.reduce((b:any,r:any)=>Math.abs(r.strike-h.spot)<Math.abs(b.strike-h.spot)?r:b,h.rungs[0]).ticker:null;
  const refStrike=h?.rungs?.length&&h.kHour!=null?h.rungs.reduce((b:any,r:any)=>Math.abs(r.strike-h.kHour)<Math.abs(b.strike-h.kHour)?r:b,h.rungs[0]).ticker:null;
  // Only strikes with a live two-sided market (or a model price between 2% and 98%) — the rest are settled in all but name.
  const view=(h?.rungs??[]).filter((r:any)=>(h.spot==null||Math.abs(r.strike-h.spot)<=1000)&&(r.mid!=null||(r.quant!=null&&r.quant>.02&&r.quant<.98)));
  const totals=h?.history?.totals??{};
  // Shown with or without a current hour, so results stay visible while Kalshi has no hourly market open.
  const pastHours=h?<>
      <Collapsible open title="Past hours" icon={<History aria-hidden className="size-4 text-info"/>} aside={totals['900']?.n?`15-min-left call ${Math.round(totals['900'].rate*100)}% right (${totals['900'].hits}/${totals['900'].n})`:'calls & results'}>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">{HORIZONS.map(([k,l])=>{const t=totals[k];return <div key={k} className="rounded-xl border border-line bg-surface-2/50 p-3"><div className="label">{l} left</div><div className="num mt-1 text-lg">{t?.n?pct(t.rate,0):'—'}</div><div className="text-xs text-muted">{t?.hits??0}/{t?.n??0} right{t?.brier!=null?` · Brier ${t.brier.toFixed(3)}`:''}{t?.kalshiBrier!=null?` (Kalshi ${t.kalshiBrier.toFixed(3)})`:''}</div></div>;})}</div>
        {h.history?.rows?.length?<div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Hour closed','Open ref','Settled avg','Result',...HORIZONS.map(([,l])=>l)].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
          <tbody>{h.history.rows.map((r:any)=><tr key={r.event} className="border-t border-line"><td className="py-2 pr-3 num">{et(r.close)}</td><td className="num pr-3">{dollars(r.kHour)}</td><td className="num pr-3">{dollars(r.settle)}</td><td className="pr-3">{r.result?<Pill tone={r.result==='yes'?'yes':'no'}>{r.result==='yes'?'UP':'DOWN'}</Pill>:<span className="text-xs text-muted">pending</span>}</td>
            {HORIZONS.map(([k])=>{const c=r.calls[k];if(!c)return <td key={k} className="pr-3 text-faint">—</td>;const ok=r.result?(c.direction==='UP')===(r.result==='yes'):null;return <td key={k} className="pr-3"><span className={c.direction==='UP'?'text-yes':'text-no'}>{c.direction==='UP'?'▲':'▼'}{pct(c.direction==='UP'?c.p:1-c.p,0)}</span>{ok===null?null:ok?<Check aria-label="right" className="ml-1 inline size-3.5 text-yes"/>:<X aria-label="wrong" className="ml-1 inline size-3.5 text-no"/>}</td>;})}</tr>)}</tbody></table></div>
        :<p className="text-sm text-muted">Hours appear here once the app has been running at their open. Calls are frozen at 45, 30, 15, 5 and 1 minute left.</p>}
      </Collapsible>
      </>:null;
  return <>
    <div aria-hidden className="ambient" data-tone={!fresh?'warn':best?tone:'none'}/>
    <SiteHeader current="/hourly" aside={<span className="num hidden truncate text-xs text-muted xl:inline">{h?.event??'waiting for hourly market'}</span>}>
      <SoundToggle prefs={sound.prefs} setPrefs={sound.setPrefs} ready={sound.ready}/>
      <Pill tone={fresh?'yes':'warn'}><span className={fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{fresh?'Live':connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      {!h?.event?<><Card className="space-y-1"><p className="text-sm">{!fresh?'Live state unavailable.':h?.error?`Hourly prices unavailable: ${h.error}`:'No hourly Bitcoin market is open on Kalshi right now.'}</p>
        {fresh&&h&&!h.error?<p className="text-sm text-muted">{h.next?`Next hourly market opens ${opensAt(h.next.open)} and closes ${opensAt(h.next.close)}.`:'Kalshi has not listed the next hourly market yet; this updates every minute.'} {maintenanceNote()??''}</p>:null}</Card>
        {h?pastHours:null}</>:<>
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className={cn('rise lg:col-span-8',best?(best.side==='yes'?'border-yes/40':'border-no/40'):'')}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><div className="label">Hour closes {et(h.close)} · {local(h.close)} your time</div><div className={cn('num mt-1 text-5xl font-bold sm:text-6xl',h.tau<=60&&'text-warn')}>{hm(Math.max(0,Math.floor(h.tau)))}</div></div>
            <div className="flex gap-6 text-right"><div><div className="label">Net edge</div><div className={cn('num mt-1 text-3xl font-semibold',best?'text-yes':'text-muted')}>{best?signedCents(best.edge):'—'}</div></div><div><div className="label">Contracts</div><div className="num mt-1 text-3xl font-semibold">{best?.contracts??0}</div>{best?.belowMinSize?<div className="text-xs text-info">paper only</div>:null}</div></div>
          </div>
          <div className={cn('font-display mt-4 text-5xl leading-none font-bold tracking-tight uppercase sm:text-7xl',best?(best.side==='yes'?'text-yes':'text-no'):'text-fg')}>{h.action}</div>
          <p className="mt-3 max-w-3xl text-[15px] text-fg/90">{h.reason}</p>
          {best?<p className="mt-1 text-sm text-muted">Ask {cents(best.price)} + {cents(best.fee,2)} fee{best.belowMinSize?` · one contract costs ${dollars(best.price+best.fee)}`:` · spend / max loss ${dollars(best.maxLoss)}`}</p>:null}
          {best?<BacktestNote s={s} which="hourly"/>:null}
          {h.ideas?.length>1?<ul className="mt-4 space-y-1.5 text-sm">{h.ideas.slice(1).map((i:any)=><li key={i.ticker+i.side} className="flex flex-wrap justify-between gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2"><span>{i.side==='yes'?'Above':'Not above'} <span className="num">${Math.round(i.strike).toLocaleString()}</span> at <span className="num">{cents(i.price)}</span></span><span className="num text-yes">{signedCents(i.edge)}</span></li>)}</ul>:null}
          <p className="mt-4 text-xs text-faint">Same gates as the 15-minute advisor (edge after fees, spread, depth, feeds, guardrails); every best idea is paper-traded and scored on Calibration.</p>
        </Card>
        <Card className="rise flex flex-col gap-4 lg:col-span-4 [animation-delay:60ms]">
          <div className="flex items-center justify-between"><span className="label">This hour · up or down</span>{up?<span className="text-xs text-muted">{up.confidence}</span>:null}</div>
          {up?<><div className="flex items-end justify-between"><div className={cn('font-display text-6xl leading-none font-bold',up.direction==='UP'?'text-yes':'text-no')}>{up.direction}</div><div className="num text-3xl">{pct(up.direction==='UP'?up.quant:1-up.quant)}</div></div>
            <ProbBar p={up.quant} mid={up.kalshi} label="Hour up"/>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span>Model {pct(up.model)}</span><span className="flex items-center gap-1"><span className="inline-block h-3 w-0.5 bg-info"/>Kalshi ladder {pct(up.kalshi)}</span></div></>
          :<p className="text-sm text-muted">{h.kHour==null?'Needs the 60 s of prices before this hour opened — available from the next hour if the app was not running then.':'Waiting for the model.'}</p>}
          <dl className="grid grid-cols-2 gap-y-1.5 border-t border-line pt-3 text-sm"><dt className="text-muted">Hour-open reference</dt><dd className="num text-right">{dollars(h.kHour)}</dd><dt className="text-muted">BTC proxy</dt><dd className="num text-right">{dollars(h.spot)}</dd><dt className="text-muted">Distance</dt><dd className={cn('num text-right',h.spot!=null&&h.kHour!=null&&(h.spot>=h.kHour?'text-yes':'text-no'))}>{h.spot!=null&&h.kHour!=null?signedDollars(h.spot-h.kHour):'—'}</dd><dt className="text-muted">Next hour</dt><dd className="num text-right">{h.next?et(h.next.close):'—'}</dd></dl>
          <p className="text-xs text-faint">Kalshi has no single hourly up/down contract; "up" means the closing 60-s average beats the 60-s average before the hour opened. Trade it through the strike nearest that reference.</p>
        </Card>
      </div>
      {h.exits?.length?<Card className="border-info/30"><div className="mb-3 flex items-center gap-2"><Wallet aria-hidden className="size-4 text-info"/><span className="label">Your hourly positions · exit plan</span></div>
        {h.exits.map((e:any)=><div key={e.ticker} className="flex flex-wrap items-end justify-between gap-4 border-t border-line py-3 first:border-0 first:pt-0"><div><div className={cn('font-display text-4xl font-bold uppercase',{'RIDE':'text-yes','LET IT RIDE':'text-yes','TAKE PROFIT':'text-yes','LET IT SETTLE':'text-yes','CUT LOSS':'text-no','SELL':'text-warn','SELL NOW':'text-warn'}[e.action as string]??'text-fg',e.urgent&&'animate-pulse motion-reduce:animate-none')}>{e.action}</div>
          <div className="mt-1 text-sm">{qty(e.contracts)} {e.side.toUpperCase()} on above <span className="num">${Math.round(e.strike??0).toLocaleString()}</span> · cost <span className="num">{cents(e.avgCost)}</span>{e.costSource==='exposure'?' (before fees)':' incl. fees'} · win chance <span className="num">{pct(e.winProb,0)}</span></div><p className="mt-1 text-sm text-muted">{String(e.reason).split(' Plan: ')[0]}</p>{e.notice?<p role="status" className={cn('mt-2 rounded-xl border px-3 py-2 text-sm',e.notice.tone==='yes'?'border-yes/40 bg-yes-dim/30':e.notice.tone==='warn'?'border-warn/40 bg-warn-dim/30':'border-no/40 bg-no-dim/30')}><span className="font-medium">{e.notice.title}.</span> {e.notice.text}</p>:null}</div>
          <div className="text-right"><div className="label">P&L if sold</div><div className={cn('num text-2xl',e.unrealized>0?'text-yes':e.unrealized<0?'text-no':'')}>{signedDollars(e.unrealized)}</div></div></div>)}</Card>:null}
      <Collapsible open title="Strike ladder" icon={<Layers aria-hidden className="size-4 text-info"/>} aside={`${view.length} strikes near the price · updated ${h.updated?Math.max(0,Math.round((Date.now()-h.updated)/1000)):'—'}s ago`}>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['BTC above','vs now','Kalshi bid / ask','Kalshi','Quant','Buy YES edge','Buy NO edge'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
          <tbody>{view.map((r:any)=><tr key={r.ticker} className={cn('border-t border-line',r.ticker===spotStrike&&'bg-info/5',best?.ticker===r.ticker&&'bg-yes-dim/30')}>
            <th scope="row" className="py-1.5 pr-3 text-left font-medium"><span className="num">${Math.round(r.strike).toLocaleString()}</span>{r.ticker===spotStrike?<span className="ml-2 text-xs text-info">≈ now</span>:null}{r.ticker===refStrike?<span className="ml-2 text-xs text-warn">hour open</span>:null}</th>
            <td className="num pr-3 text-muted">{h.spot!=null?signedDollars(r.strike-h.spot):'—'}</td><td className="num pr-3">{cents(r.yesBid)} / {cents(r.yesAsk)}</td><td className="num pr-3 text-info">{pct(r.mid,0)}</td><td className="num pr-3">{pct(r.quant,0)}</td>
            <td className={cn('num pr-3',r.edgeYes>=(s?.config?.minEdge??.04)?'text-yes':r.edgeYes>0?'text-fg':'text-faint')}>{signedCents(r.edgeYes)}</td><td className={cn('num',r.edgeNo>=(s?.config?.minEdge??.04)?'text-yes':r.edgeNo>0?'text-fg':'text-faint')}>{signedCents(r.edgeNo)}</td></tr>)}</tbody></table></div>
        <p className="mt-3 text-xs text-faint">YES pays $1 if the closing 60-s BRTI average is above the strike. Edges are quant probability minus the ask minus the taker fee. Strikes are $100 apart; only strikes with a live two-sided market within $1,000 of the price are shown.</p>
      </Collapsible>
      {pastHours}
      <Card className="flex items-start gap-3 text-xs text-muted"><Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info"/><span>Settlement: the simple average of CF Benchmarks&apos; BRTI over the 60 s before the top of the hour (ET), exactly like the 15-minute markets. The hourly model uses the same volatility, basis correction and final-minute locking; σ over an hour is wider, so probabilities stay closer to 50% until late. <Clock aria-hidden className="inline size-3.5"/> Trade sizes use your normal risk settings.</span></Card>
      </>}
    </main>
  </>;
}
