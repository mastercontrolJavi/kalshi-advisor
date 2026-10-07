'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {Check,X,Info,ChevronRight,ArrowUpRight,ArrowDownRight,Minus,Radio,Gauge,Wallet,BookOpen,Layers,ShieldCheck,Activity,TriangleAlert,Crosshair} from 'lucide-react';
import {Card} from './ui/card';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,cents,signedCents,pct,qty,mmss,ago} from './format';

export type Tone='yes'|'no'|'warn'|'neutral';
const toneText:Record<Tone,string>={yes:'text-yes',no:'text-no',warn:'text-warn',neutral:'text-fg'};
const toneBorder:Record<Tone,string>={yes:'border-yes/40',no:'border-no/40',warn:'border-warn/40',neutral:'border-line'};
export const actionTone=(action:string):Tone=>action==='BUY YES'?'yes':action==='BUY NO'?'no':'neutral';

/** Mobile-first: closed on phones so the call stays on the first screen; `open` panels expand on ≥1024px. */
export function Collapsible({title,icon,aside,open=false,children}:{title:string;icon?:ReactNode;aside?:ReactNode;open?:boolean;children:ReactNode}){
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(open&&ref.current&&window.matchMedia('(min-width: 1024px)').matches)ref.current.open=true;},[open]);
  return <Card className="p-0"><details ref={ref}>
    <summary className="flex min-h-14 items-center gap-3 px-5 py-3"><ChevronRight aria-hidden className="chev size-4 text-faint"/>{icon}<span className="font-medium">{title}</span><span className="ml-auto text-xs text-muted">{aside}</span></summary>
    <div className="border-t border-line px-5 pb-5 pt-4">{children}</div></details></Card>;
}
function Heading({icon,title,aside}:{icon?:ReactNode;title:string;aside?:ReactNode}){
  return <div className="flex flex-wrap items-center gap-2">{icon}<h2 className="label">{title}</h2>{aside?<div className="ml-auto text-xs text-muted">{aside}</div>:null}</div>;
}
export function Pill({tone,children,title}:{tone:Tone;children:ReactNode;title?:string}){
  const bg={yes:'bg-yes-dim text-yes',no:'bg-no-dim text-no',warn:'bg-warn-dim text-warn',neutral:'bg-surface-2 text-muted'}[tone];
  return <span title={title} className={cn('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',bg)}>{children}</span>;
}

/** Horizontal P(up) scale: left = DOWN, right = UP, with Kalshi's implied price as a second marker. */
export function ProbBar({p,mid,label='Model'}:{p:number|null;mid?:number|null;label?:string}){
  const at=(v:number)=>`${Math.min(100,Math.max(0,v*100))}%`;
  return <div className="relative mt-3 h-9" role="img" aria-label={`${label} probability up ${pct(p)}${mid!=null?`, Kalshi ${pct(mid)}`:''}`}>
    <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-gradient-to-r from-no/50 via-line-strong to-yes/50"/>
    <div className="absolute top-1.5 h-5 w-px bg-faint" style={{left:'50%'}}/>
    {mid!=null?<div className="bar-fill absolute top-1 h-6 w-0.5 -translate-x-1/2 rounded bg-info" style={{left:at(mid)}} title={`Kalshi ${pct(mid)}`}/>:null}
    {p!=null?<div className="bar-fill absolute top-1 size-6 -translate-x-1/2 rounded-full border-2 border-bg bg-fg shadow" style={{left:at(p)}}/>:null}
    <div className="absolute inset-x-0 top-7 flex justify-between text-[10px] text-faint"><span>DOWN</span><span>50%</span><span>UP</span></div>
  </div>;
}

export function WindowBar({s}:{s:any}){
  const total=s?.market?(Date.parse(s.market.close_time)-Date.parse(s.market.open_time))/1000:900,tau=Math.max(0,s?.tau??0),done=s?.market?1-tau/total:0;
  return <div className="h-1 w-full bg-line" aria-hidden><div className={cn('bar-fill h-full',tau<=60?'bg-warn':'bg-info')} style={{width:`${done*100}%`}}/></div>;
}

export function SignalPanel({s,fresh}:{s:any;fresh:boolean}){
  const ev=s?.evaluation,idea=fresh?ev?.idea:null,action=fresh?ev?.action??'NO TRADE':'NO TRADE',tone=actionTone(action),tau=Math.max(0,s?.tau??0);
  const gates:any[]=fresh?ev?.gates??[]:[],failed=gates.filter(g=>!g.ok&&!g.advisory).length,paperOnly=!!idea?.belowMinSize;
  return <Card className={cn('rise relative overflow-hidden',toneBorder[tone])}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="label">Time to close</div><div className={cn('num mt-1 text-5xl font-bold sm:text-6xl',tau<=60&&s?.market?'text-warn':'')}>{s?.market?mmss(tau):'--:--'}</div>{tau<=60&&s?.market?<div className="mt-1 text-xs text-warn">Final minute · settlement average locking</div>:null}</div>
      <div className="flex gap-6 text-right"><div><div className="label">Net edge</div><div className={cn('num mt-1 text-3xl font-semibold',idea?toneText[tone]:'text-muted')}>{idea?signedCents(idea.edge):'—'}</div></div><div><div className="label">Contracts</div><div className="num mt-1 text-3xl font-semibold">{idea?.contracts??0}</div>{paperOnly?<div className="text-xs text-info">paper only</div>:null}</div></div>
    </div>
    <div className={cn('font-display mt-4 text-6xl leading-none font-bold tracking-tight uppercase sm:text-8xl',toneText[tone])} aria-live="polite">{action}</div>
    <p className="mt-3 max-w-3xl text-[15px] text-fg/90">{fresh?(idea?ev.reason:failed?`${failed} of ${gates.length} checks failing`:ev?.reason??'Warming up'):'Live state unavailable — advice suppressed'}</p>
    {idea?<p className="mt-1 text-sm text-muted">{paperOnly?<><span className="text-info">Below 1 contract at your risk settings — logged as a paper trade.</span> One contract would cost {dollars(idea.price+idea.fee)}.</>:<>Spend / max loss {dollars(idea.maxLoss)} · ask {cents(idea.price)} + {cents(idea.fee,2)} fee</>}</p>:null}
    {gates.length?<ul className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label="Trade checks">{gates.some(g=>g.ok)?<li className="flex items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-sm text-muted sm:hidden"><Check aria-hidden className="size-4 text-yes"/>{gates.filter(g=>g.ok).length} passing</li>:null}{gates.map(g=>{const info=!g.ok&&g.advisory;return <li key={g.key} className={cn('items-start gap-2 rounded-xl border px-3 py-2',g.ok?'hidden border-line bg-surface-2/60 sm:flex':info?'flex border-info/35 bg-info/10':'flex border-warn/35 bg-warn-dim/40')}>
      {g.ok?<Check aria-label="pass" className="mt-0.5 size-4 shrink-0 text-yes"/>:info?<Info aria-label="information" className="mt-0.5 size-4 shrink-0 text-info"/>:<X aria-label="fail" className="mt-0.5 size-4 shrink-0 text-warn"/>}
      <div className="min-w-0"><div className="text-sm font-medium">{g.label}</div><div className={cn('text-xs leading-snug',g.ok?'text-faint':info?'text-info':'text-warn')}>{g.detail}</div></div></li>;})}</ul>:null}
    <p className="mt-4 text-xs text-faint">Model is a proxy diffusion estimate — check Calibration before relying on edge. YES edge {signedCents(s?.model?ev?.edges?.yes:null)} · NO edge {signedCents(s?.model?ev?.edges?.no:null)}</p>
  </Card>;
}

const DirIcon=({d,className}:{d:string;className?:string})=>d==='UP'?<ArrowUpRight aria-hidden className={className}/>:d==='DOWN'?<ArrowDownRight aria-hidden className={className}/>:<Minus aria-hidden className={className}/>;
export function ForecastPanel({s,fresh}:{s:any;fresh:boolean}){
  const live=fresh?s?.liveCall:null,q=s?.quality,open=s?.openingCall,rec=s?.calibration?.opening,liveTone:Tone=live?(live.direction==='UP'?'yes':'no'):'neutral';
  const qTone:Tone=q?.level==='solid'?'yes':q?.level==='degraded'?'warn':'no',held=live?Math.max(0,(s.engineTime-live.since)/1000):0;
  const elapsed=s?.market?(Date.parse(s.market.close_time)-Date.parse(s.market.open_time))/1000-(s?.tau??0):null;
  return <Card className="rise flex flex-col gap-5 [animation-delay:60ms]">
    <section>
      <Heading icon={<Radio aria-hidden className="size-4 text-info"/>} title="Live call" aside={q?<Pill tone={qTone} title={q.issues.join(' · ')}>{q.level==='solid'?<ShieldCheck aria-hidden className="size-3.5"/>:<TriangleAlert aria-hidden className="size-3.5"/>}Data {q.level}</Pill>:null}/>
      {live?<>
        <div className="mt-3 flex items-end gap-3"><DirIcon d={live.direction} className={cn('size-12',toneText[liveTone])}/><div className={cn('font-display text-6xl leading-none font-bold',toneText[liveTone])}>{live.direction}</div>
          <div className="mb-1 ml-auto text-right"><div className="num text-3xl font-semibold">{pct(live.direction==='UP'?live.p:1-live.p)}</div><div className="text-xs text-muted">{live.confidence}</div></div></div>
        <ProbBar p={live.p} mid={s?.book?.yesBid!=null&&s?.book?.yesAsk!=null?(s.book.yesBid+s.book.yesAsk)/2:null} label="Live call"/>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span>Held <span className="num text-fg">{mmss(held)}</span></span><span>{live.flips} flip{live.flips===1?'':'s'} this window</span><span>Model alone {pct(live.baseP)}</span><span className="flex items-center gap-1"><span className="inline-block h-3 w-0.5 bg-info"/>Kalshi</span></div>
        <details className="mt-3"><summary className="flex min-h-9 items-center gap-1 text-xs text-muted"><ChevronRight aria-hidden className="chev size-3.5"/>Why this call</summary><ul className="mt-2 space-y-1 text-xs text-muted">{live.reasons.map((r:string)=><li key={r}>{r}</li>)}</ul></details>
      </>:<p className="mt-3 text-sm text-muted">{!fresh?'Live state unavailable.':q?.level==='unreliable'?`Paused — ${q.issues.join(', ')}.`:'Waiting for the model.'}</p>}
      {q?.level==='degraded'?<p className="mt-2 text-xs text-warn">{q.issues.join(' · ')}</p>:null}
    </section>
    <section className="border-t border-line pt-4">
      <Heading icon={<Crosshair aria-hidden className="size-4 text-faint"/>} title="Opening call" aside={rec?.count?<span>{rec.hits}/{rec.count} correct · CI {pct(rec.low,0)}–{pct(rec.high,0)}</span>:<span>no settled calls yet</span>}/>
      {open?<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1"><span className={cn('font-display flex items-center gap-1 text-3xl font-bold',open.direction==='UP'?'text-yes':'text-no')}><DirIcon d={open.direction} className="size-6"/>{open.direction}</span><span className="num text-lg">{pct(open.direction==='UP'?open.p:1-open.p)}</span>
        {s?.proxy!=null&&s?.K!=null?<Pill tone={(s.proxy>=s.K)===(open.direction==='UP')?'yes':'warn'}>{(s.proxy>=s.K)===(open.direction==='UP')?'On track':'Behind'}</Pill>:null}<span className="text-xs text-faint">frozen at {mmss(open.tau)} left · Kalshi {pct(open.mid)}</span></div>
      :<p className="mt-2 text-sm text-muted">{s?.market&&elapsed!==null&&elapsed<60?'Making the call for this window…':'No call this window — the engine was not live in its first minute.'}</p>}
    </section>
    <p className="text-xs text-faint">Both calls use an untested momentum/flow lean (max ±10 pts). Scored on the Calibration page against a coin flip and Kalshi.</p>
  </Card>;
}

function Stat({label,children,sub,tone='neutral'}:{label:string;children:ReactNode;sub?:ReactNode;tone?:Tone}){
  return <div className="min-w-0"><div className="label">{label}</div><div className={cn('num mt-1.5 text-xl font-medium sm:text-2xl',toneText[tone])}>{children}</div>{sub?<div className="mt-0.5 truncate text-xs text-muted">{sub}</div>:null}</div>;
}
export function Instruments({s}:{s:any}){
  const mid=s?.book?.yesBid!=null&&s?.book?.yesAsk!=null?(s.book.yesBid+s.book.yesAsk)/2:null,d=s?.distance;
  return <Card className="rise grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6 [animation-delay:120ms]">
    <Stat label={`Opening K${s?.kConfirmed?' ✓':' (est.)'}`} sub={s?.kConfirmed?'Kalshi floor strike':'estimated from proxy'}>{dollars(s?.K)}</Stat>
    <Stat label="BTC proxy" sub={`median of ${s?.venues?.filter((v:any)=>v.healthy).length??0} live venues`}>{dollars(s?.proxy)}</Stat>
    <Stat label="Distance to K" tone={d>0?'yes':d<0?'no':'neutral'} sub={s?.model?`${s.model.z>=0?'+':''}${s.model.z.toFixed(2)} σ of average`:'—'}>{signedDollars(d)}</Stat>
    <Stat label="Model up" sub={<>Kalshi mid <span className="text-info">{pct(mid)}</span></>}>{pct(s?.p)}</Stat>
    <Stat label="Volatility" sub={`${s?.vol?.count??0} returns · ${s?.lockedCount??0}/60 locked`}>{s?.regime??'warming'}</Stat>
    <Stat label="Balance" sub={s?.account?.ready?'account synced':'account unavailable'}>{dollars(s?.account?.balance)}</Stat>
  </Card>;
}

export function Positions({s,fresh}:{s:any;fresh:boolean}){
  const exits:any[]=fresh?s?.exits??[]:[];
  if(!exits.length)return <Card className="flex min-h-14 flex-wrap items-center gap-3 py-3"><Wallet aria-hidden className="size-4 text-faint"/><span className="label">Your positions</span><span className="ml-auto text-sm text-muted">{s?.account?.ready?'No open BTC 15-min position':'Waiting for account'}</span></Card>;
  return <Card className="rise border-info/30"><Heading icon={<Wallet aria-hidden className="size-4 text-info"/>} title="Your positions · hold or sell" aside="refreshes on each fill"/>
    {exits.map(e=>{const t:Tone=e.action==='SELL NOW'?'warn':e.action==='HOLD'?'yes':'neutral';return <div key={e.ticker} className="mt-4 grid gap-4 border-t border-line pt-4 first-of-type:border-0 first-of-type:pt-0 lg:grid-cols-[1fr_auto]">
      <div><div className={cn('font-display text-5xl leading-none font-bold uppercase',toneText[t])}>{e.action}</div><div className="mt-2 text-sm"><span className="num">{qty(e.contracts)}</span> {e.side.toUpperCase()} · avg cost <span className="num">{cents(e.avgCost)}</span> <span className="num ml-1 text-xs text-faint">{e.ticker}</span></div><p className="mt-2 text-sm text-muted">{e.reason}{e.limitPrice!=null?` Or list a sell at ${cents(e.limitPrice)} and wait for a buyer.`:''}</p></div>
      <div className="grid grid-cols-3 gap-5 self-start text-right"><Stat label="Hold value" sub={`${pct(e.winProb)} to win`}>{dollars(e.holdValue)}</Stat><Stat label="Sell now" sub={`bid ${cents(e.bid)} − ${dollars(e.sellFee)} fee`}>{dollars(e.sellValue)}</Stat><Stat label="P&L if sold" tone={e.unrealized>0?'yes':e.unrealized<0?'no':'neutral'}>{signedDollars(e.unrealized)}</Stat></div></div>;})}
    <p className="mt-4 text-xs text-faint">Expected value under an uncalibrated model; not a guarantee of the best exit.</p></Card>;
}

export function BookLadder({s}:{s:any}){
  const sides=(['yes','no'] as const).map(side=>({side,levels:(s?.book?.[side]??[]) as number[][],ask:s?.book?.[side==='yes'?'yesAsk':'noAsk']}));
  const max=Math.max(1,...sides.flatMap(x=>x.levels.slice(0,10).map(l=>l[1])));
  return <div className="grid grid-cols-2 gap-4">{sides.map(({side,levels,ask})=><div key={side}>
    <div className="mb-2 flex items-baseline justify-between"><span className={cn('text-sm font-semibold',side==='yes'?'text-yes':'text-no')}>{side.toUpperCase()} bids</span><span className="text-xs text-muted">ask <span className="num text-fg">{cents(ask)}</span></span></div>
    <ul className="space-y-0.5" aria-label={`${side.toUpperCase()} bids, price and contracts`}>{levels.slice(0,10).map(([price,q])=><li key={price} className="relative flex h-8 items-center justify-between overflow-hidden rounded-md px-2 text-sm">
      <span aria-hidden className="absolute inset-y-0 right-0 rounded-md" style={{width:`${q/max*100}%`,background:side==='yes'?'rgb(62 224 143 / .14)':'rgb(255 107 134 / .14)'}}/>
      <span className="num relative">{cents(price)}</span><span className="num relative text-muted">{qty(q)}</span></li>)}</ul>
    {!levels.length?<p className="py-6 text-center text-xs text-faint">No bids</p>:null}</div>)}
    <p className="col-span-2 text-xs text-faint">Each side&apos;s ask is 1 − the other side&apos;s best bid. Source: {s?.book?.source??'unavailable'}.</p></div>;
}

export function MakerIdeas({s,fresh}:{s:any;fresh:boolean}){
  const makers:any[]=fresh?s?.evaluation?.makers??[]:[];
  return <div className="space-y-3">{makers.length?makers.map(m=><div key={m.side} className="flex items-center justify-between rounded-xl border border-line bg-surface-2/60 p-4">
    <div><div className="font-medium">Bid {m.side.toUpperCase()} at <span className="num">{cents(m.price)}</span></div><div className="mt-1 text-xs text-muted"><span className="num">{qty(Math.round(m.queue))}</span> contracts ahead · {m.contracts} suggested</div></div>
    <div className="text-right"><div className={cn('num text-lg',m.side==='yes'?'text-yes':'text-no')}>{signedCents(m.edge)}</div><div className="text-xs text-muted">if filled</div></div></div>)
    :<p className="text-sm text-muted">No eligible resting-bid ideas right now.</p>}
    <p className="text-xs text-faint">Post a lower bid and wait for a seller (no fee on KXBTC15M). Fills often come right before the price moves against you; that effect is not yet measured.</p></div>;
}

export function Session({s}:{s:any}){
  const g=s?.guards,warnings:any[]=s?.realWarnings??[],cfg=s?.config;
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-4"><Stat label="P&L today" tone={g?.pnl>0?'yes':g?.pnl<0?'no':'neutral'}>{signedDollars(g?.pnl)}</Stat><Stat label="Trades">{g?.trades??0}</Stat><Stat label="Win rate">{pct(g?.winRate)}</Stat><Stat label="Streak" tone={g?.streak>0?'yes':g?.streak<0?'no':'neutral'}>{g?.streak>0?`+${g.streak}`:g?.streak??0}</Stat></div>
    <div className="space-y-1.5 text-sm"><div className="flex justify-between"><span className="text-muted">This hour</span><span className="num">{g?.hourly??0} / {cfg?.maxTradesPerHour??'—'}</span></div><div className="flex justify-between"><span className="text-muted">Daily loss limit</span><span className="num">{g?.startBalance?dollars(-g.startBalance*(cfg?.dailyLossLimit??0)):'—'}</span></div><div className="flex justify-between"><span className="text-muted">Status</span><span className={g?.locked?'text-warn':'text-yes'}>{g?.reason??'clear'}</span></div></div>
    {warnings.length?<ul className="space-y-1.5 border-t border-line pt-3">{warnings.flatMap((w:any)=>w.warnings.map((t:string)=><li key={w.id+t} className="flex gap-2 text-xs text-warn"><TriangleAlert aria-hidden className="size-3.5 shrink-0"/>{t}</li>))}</ul>:null}</div>;
}

export function Feeds({s}:{s:any}){
  const age=s?Date.now()-s.engineTime:null;
  return <div className="space-y-3">
    <ul className="space-y-2">{s?.venues?.map((v:any)=><li key={v.name} className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2"><span className={cn('size-2 rounded-full',v.healthy?'bg-yes':'bg-warn')}/>{v.name}<span className="sr-only">{v.healthy?'live':'stale'}</span></span><span className="num">{dollars(v.mid)}</span><span className="w-28 text-right text-xs text-muted">quote {ago(v.age)}</span></li>)}</ul>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs"><dt className="text-muted">Kalshi stream</dt><dd className="num text-right">{s?.kalshi?.status??'—'} · {s?.kalshi?.lag==null?'n/a':`${Math.round(s.kalshi.lag)}ms`}</dd><dt className="text-muted">Engine loop</dt><dd className="num text-right">{s?.loopMs?.toFixed(1)??'—'}ms</dd><dt className="text-muted">Data age on screen</dt><dd className="num text-right">{age==null?'—':ago(Math.max(0,age))}</dd><dt className="text-muted">Server clock offset</dt><dd className="num text-right">{s?.kalshi?.clockOffset?.toFixed(0)??'—'}ms</dd><dt className="text-muted">σ per √s</dt><dd className="num text-right">{s?.sigma?(s.sigma*100).toFixed(5)+'%':'—'}</dd></dl>
    <p className="text-xs text-faint">A venue is live while its link answers within {s?.config?.staleMs??2000}ms (pinged every second) and its last quote is under 15 s old. Venues only send quotes when prices change.</p>
    {s?.account?.error?<p className="text-xs text-warn">{s.account.error}</p>:null}</div>;
}

export const icons={Gauge,BookOpen,Layers,Activity,ShieldCheck};
