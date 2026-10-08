'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {Check,X,Info,Clock,Zap,TrendingDown,ChevronRight,ArrowUpRight,ArrowDownRight,Minus,Radio,Gauge,Wallet,BookOpen,Layers,ShieldCheck,Activity,TriangleAlert,Crosshair,FlaskConical} from 'lucide-react';
import {Card} from './ui/card';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,cents,signedCents,pct,qty,mmss,ago} from './format';
import {ruleVerdict,exitVerdict} from '@/backtest/verdict';

export type Tone='yes'|'no'|'warn'|'neutral';
const toneText:Record<Tone,string>={yes:'text-yes',no:'text-no',warn:'text-warn',neutral:'text-fg'};
const toneBorder:Record<Tone,string>={yes:'border-yes/40',no:'border-no/40',warn:'border-warn/40',neutral:'border-line'};
export const actionTone=(action:string):Tone=>action==='BUY YES'?'yes':action==='BUY NO'?'no':'neutral';

/** Mobile-first: closed on phones so the call stays on the first screen; `open` panels expand on ≥1024px. */
/** `remember` keeps the panel open or minimized across reloads (per browser), shared by every page that uses the key. */
export function Collapsible({title,icon,aside,open=false,remember,className,children}:{title:string;icon?:ReactNode;aside?:ReactNode;open?:boolean;remember?:string;className?:string;children:ReactNode}){
  const ref=useRef<HTMLDetailsElement>(null),key=remember?'panel:'+remember:null;
  useEffect(()=>{const el=ref.current;if(!el)return;let saved:string|null=null;if(key){try{saved=localStorage.getItem(key);}catch{}}
    if(saved!==null)el.open=saved==='open';else if(open&&window.matchMedia('(min-width: 1024px)').matches)el.open=true;},[open,key]);
  const toggled=key?(e:React.SyntheticEvent<HTMLDetailsElement>)=>{try{localStorage.setItem(key,e.currentTarget.open?'open':'closed');}catch{}}:undefined;
  return <Card className={cn('p-0',className)}><details ref={ref} onToggle={toggled}>
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

/** How the same BUY rule did on past rounds (npm run backtest), shown beside every BUY signal. */
export function BacktestNote({s,which}:{s:any;which:'15m'|'hourly'}){
  const v=ruleVerdict(s?.backtest??null,which,Date.now(),which==='15m'&&s?.quant?.signalSource==='model'?'model':'quant');
  return <div className={cn('mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm',v.tone==='warn'?'border-warn/40 bg-warn-dim/30':v.tone==='yes'?'border-yes/35 bg-yes-dim/30':'border-line bg-surface-2/60')}>
    <FlaskConical aria-hidden className={cn('mt-0.5 size-4 shrink-0',v.tone==='warn'?'text-warn':v.tone==='yes'?'text-yes':'text-muted')}/><span>{v.text}</span></div>;
}

export function WindowBar({s}:{s:any}){
  const total=s?.market?(Date.parse(s.market.close_time)-Date.parse(s.market.open_time))/1000:900,tau=Math.max(0,s?.tau??0),done=s?.market?1-tau/total:0;
  return <div className="h-1 w-full bg-line" aria-hidden><div className={cn('bar-fill h-full',tau<=60?'bg-warn':'bg-info')} style={{width:`${done*100}%`}}/></div>;
}

export function SignalPanel({s,fresh}:{s:any;fresh:boolean}){
  const ev=s?.evaluation,idea=fresh?ev?.idea:null,action=fresh?ev?.action??'NO TRADE':'NO TRADE',tone=actionTone(action),tau=Math.max(0,s?.tau??0);
  const gates:any[]=fresh?ev?.gates??[]:[],failed=gates.filter(g=>!g.ok&&!g.advisory&&!g.wait).length,waiting=gates.find(g=>!g.ok&&g.wait),paperOnly=!!idea?.belowMinSize;
  return <Card className={cn('rise relative overflow-hidden',toneBorder[tone])}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="label">Time to close</div><div className={cn('num mt-1 text-5xl font-bold sm:text-6xl',tau<=60&&s?.market?'text-warn':'')}>{s?.market?mmss(tau):'--:--'}</div>{tau<=60&&s?.market?<div className="mt-1 text-xs text-warn">Final minute · settlement average locking</div>:null}</div>
      <div className="flex gap-6 text-right"><div><div className="label">Net edge</div><div className={cn('num mt-1 text-3xl font-semibold',idea?toneText[tone]:'text-muted')}>{idea?signedCents(idea.edge):'—'}</div></div><div><div className="label">Contracts</div><div className="num mt-1 text-3xl font-semibold">{idea?.contracts??0}</div>{paperOnly?<div className="text-xs text-info">paper only</div>:null}</div></div>
    </div>
    <div className={cn('font-display mt-4 text-6xl leading-none font-bold tracking-tight uppercase sm:text-8xl',toneText[tone])} aria-live="polite">{action}</div>
    <p className="mt-3 max-w-3xl text-[15px] text-fg/90">{fresh?(idea?ev.reason:failed?`${failed} of ${gates.length} checks failing${waiting?` · ${waiting.label.toLowerCase()} ${waiting.detail}`:''}`:waiting?`All checks clear — waiting: ${waiting.detail}`:ev?.reason??'Warming up'):'Live state unavailable — advice suppressed'}</p>
    {idea?<BacktestNote s={s} which="15m"/>:null}
    {idea?<p className="mt-1 text-sm text-muted">{paperOnly?<><span className="text-info">Below 1 contract at your risk settings — logged as a paper trade.</span> One contract would cost {dollars(idea.price+idea.fee)}.</>:<>Spend / max loss {dollars(idea.maxLoss)} · ask {cents(idea.price)} + {cents(idea.fee,2)} fee</>}</p>:null}
    {gates.length?<ul className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label="Trade checks">{gates.some(g=>g.ok)?<li className="flex items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-sm text-muted sm:hidden"><Check aria-hidden className="size-4 text-yes"/>{gates.filter(g=>g.ok).length} passing</li>:null}{gates.map(g=>{const info=!g.ok&&g.advisory,wait=!g.ok&&g.wait;return <li key={g.key} className={cn('items-start gap-2 rounded-xl border px-3 py-2',g.ok?'hidden border-line bg-surface-2/60 sm:flex':wait?'flex border-line-strong bg-surface-2/60':info?'flex border-info/35 bg-info/10':'flex border-warn/35 bg-warn-dim/40')}>
      {g.ok?<Check aria-label="pass" className="mt-0.5 size-4 shrink-0 text-yes"/>:wait?<Clock aria-label="waiting" className="mt-0.5 size-4 shrink-0 text-muted"/>:info?<Info aria-label="information" className="mt-0.5 size-4 shrink-0 text-info"/>:<X aria-label="fail" className="mt-0.5 size-4 shrink-0 text-warn"/>}
      <div className="min-w-0"><div className="text-sm font-medium">{g.label}</div><div className={cn('text-xs leading-snug',g.ok||wait?'text-faint':info?'text-info':'text-warn')}>{g.detail}</div></div></li>;})}</ul>:null}
    <p className="mt-4 text-xs text-faint">Edges use the {s?.quant?.signalSource==='quant'?'quant forecast (model blended with Kalshi)':'raw model'} after fees — YES {signedCents(s?.model?ev?.edges?.yes:null)} · NO {signedCents(s?.model?ev?.edges?.no:null)}. {ruleVerdict(s?.backtest??null,'15m',Date.now(),s?.quant?.signalSource==='model'?'model':'quant').text}</p>
  </Card>;
}

const DirIcon=({d,className}:{d:string;className?:string})=>d==='UP'?<ArrowUpRight aria-hidden className={className}/>:d==='DOWN'?<ArrowDownRight aria-hidden className={className}/>:<Minus aria-hidden className={className}/>;
export function ForecastPanel({s,fresh}:{s:any;fresh:boolean}){
  const live=fresh?s?.liveCall:null,q=s?.quality,open=s?.openingCall,rec=s?.calibration?.opening,liveTone:Tone=live?(live.direction==='UP'?'yes':'no'):'neutral';
  const qTone:Tone=q?.level==='solid'?'yes':q?.level==='degraded'?'warn':'no',held=live?Math.max(0,(s.engineTime-live.since)/1000):0;
  const elapsed=s?.market?(Date.parse(s.market.close_time)-Date.parse(s.market.open_time))/1000-(s?.tau??0):null;
  return <Card className="rise flex flex-col gap-5 [animation-delay:60ms]">
    <section>
      <Heading icon={<Radio aria-hidden className="size-4 text-info"/>} title="Live call · quant" aside={q?<Pill tone={qTone} title={q.issues.join(' · ')}>{q.level==='solid'?<ShieldCheck aria-hidden className="size-3.5"/>:<TriangleAlert aria-hidden className="size-3.5"/>}Data {q.level}</Pill>:null}/>
      {live?<>
        <div className="mt-3 flex items-end gap-3"><DirIcon d={live.direction} className={cn('size-12',toneText[liveTone])}/><div className={cn('font-display text-6xl leading-none font-bold',toneText[liveTone])}>{live.direction}</div>
          <div className="mb-1 ml-auto text-right"><div className="num text-3xl font-semibold">{pct(live.direction==='UP'?live.p:1-live.p)}</div><div className="text-xs text-muted">{live.confidence}</div></div></div>
        <ProbBar p={live.p} mid={s?.book?.yesBid!=null&&s?.book?.yesAsk!=null?(s.book.yesBid+s.book.yesAsk)/2:null} label="Live call"/>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span>Held <span className="num text-fg">{mmss(held)}</span></span><span>{live.flips} flip{live.flips===1?'':'s'} this window</span><span>Model {pct(live.baseP)}</span><span className="flex items-center gap-1"><span className="inline-block h-3 w-0.5 bg-info"/>Kalshi {pct(s?.quant?.mid)}</span><span>{s?.quant?.active==='fitted'?`learned blend · ${s.quant.markets} markets`:'default blend'}</span></div>
        <details className="mt-3"><summary className="flex min-h-9 items-center gap-1 text-xs text-muted"><ChevronRight aria-hidden className="chev size-3.5"/>Why this call</summary><ul className="mt-2 space-y-1 text-xs text-muted">{live.reasons.map((r:string)=><li key={r}>{r}</li>)}</ul></details>
      </>:<p className="mt-3 text-sm text-muted">{!fresh?'Live state unavailable.':q?.level==='unreliable'?`Paused — ${q.issues.join(', ')}.`:'Waiting for the model.'}</p>}
      {q?.level==='degraded'?<p className="mt-2 text-xs text-warn">{q.issues.join(' · ')}</p>:null}
    </section>
    <section className="border-t border-line pt-4">
      <Heading icon={<Crosshair aria-hidden className="size-4 text-faint"/>} title="Opening call" aside={rec?.count?<span>{rec.hits}/{rec.count} correct · CI {pct(rec.low,0)}–{pct(rec.high,0)}</span>:<span>no settled calls yet</span>}/>
      {open?<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1"><span className={cn('font-display flex items-center gap-1 text-3xl font-bold',open.direction==='UP'?'text-yes':'text-no')}><DirIcon d={open.direction} className="size-6"/>{open.direction}</span><span className="num text-lg">{pct(open.direction==='UP'?open.p:1-open.p)}</span>
        {s?.proxy!=null&&s?.K!=null?<Pill tone={(s.proxy>=s.K)===(open.direction==='UP')?'yes':'warn'}>{(s.proxy>=s.K)===(open.direction==='UP')?'On track':'Behind'}</Pill>:null}<span className="text-xs text-faint">frozen at {mmss(open.tau)} left · Kalshi {pct(open.mid)}{open.inputs?.kSource==='proxy estimate'?' · K estimated':''}</span></div>
      :<p className="mt-2 text-sm text-muted">{s?.market&&elapsed!==null&&elapsed<180?(s?.kConfirmed?'Making the call for this window…':'Waiting for Kalshi to publish the opening price (K). The call is made the moment it does.'):'No call this window: Kalshi had not published K within 3 minutes, or the engine was not running at the open.'}</p>}
    </section>
    <NextWindow s={s} fresh={fresh}/>
    <p className="text-xs text-faint">Calls blend the model with Kalshi; momentum/flow only count once settled windows prove them. All are scored on the Calibration page.</p>
  </Card>;
}

function NextWindow({s,fresh}:{s:any;fresh:boolean}){
  const n=fresh?s?.nextCall:null,tau=s?.tau??900,rec=s?.calibration?.next?.find((r:any)=>r.horizon===10),urgent=tau<=60;
  return <section className={cn('border-t border-line pt-4',urgent&&n?'rounded-xl border border-info/30 bg-info/5 p-3':'')}>
    <Heading icon={<Zap aria-hidden className={cn('size-4',urgent?'text-info':'text-faint')}/>} title="Next window" aside={rec?.count?<span>{rec.hits}/{rec.count} correct</span>:<span>preview</span>}/>
    {n?<><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1"><span className={cn('font-display flex items-center gap-1 text-3xl font-bold',n.direction==='UP'?'text-yes':'text-no')}><DirIcon d={n.direction} className="size-6"/>{n.direction}</span><span className="num text-lg">{pct(n.direction==='UP'?n.p:1-n.p)}</span><span className="text-xs text-muted">{n.confidence}</span></div>
      <p className="mt-1 text-xs text-muted">{tau>60?'Before the final minute the next window is a coin flip plus momentum — its opening price is set by this window\'s last 60 s.':`Head start if it closed now: ${n.headStart>=0?'+':'−'}$${Math.abs(n.headStart).toFixed(2)} (±$${n.headStartSd.toFixed(2)}) · next K ≈ ${dollars(n.expectedK)}`}</p></>
    :<p className="mt-2 text-sm text-muted">Available once the model is live.</p>}
  </section>;
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
    <Stat label="Volatility" sub={`${s?.lockedCount??0}/60 locked${s?.lockedImputed?` (${s.lockedImputed} bridged)`:''} · basis ${s?.quant?.basis>=0?'+':'−'}$${Math.abs(s?.quant?.basis??0).toFixed(2)}`}>{s?.regime??'warming'}</Stat>
    <Stat label="Balance" sub={s?.account?.ready?'account synced':'account unavailable'}>{dollars(s?.account?.balance)}</Stat>
  </Card>;
}

export function Positions({s,fresh}:{s:any;fresh:boolean}){
  const exits:any[]=fresh?s?.exits??[]:[];
  const synced=s?.account?.positionsUpdated?`synced ${ago(Math.max(0,Date.now()-s.account.positionsUpdated))} ago`:'not synced yet';
  if(!exits.length)return <Card className="flex min-h-14 flex-wrap items-center gap-3 py-3"><Wallet aria-hidden className="size-4 text-faint"/><span className="label">Your positions</span><span className="ml-auto text-sm text-muted">{s?.account?.ready?<>No open BTC 15-min position <span className="text-xs text-faint">· {synced}</span></>:'Waiting for account'}</span></Card>;
  const tones:Record<string,Tone>={'SETTLING':'neutral','RIDE':'yes','TAKE PROFIT':'yes','LET IT SETTLE':'yes','CUT LOSS':'no','SELL NOW':'warn','HOLD':'neutral','TOO LATE':'neutral','NO MODEL':'neutral'};
  const hold=s?.config?.exitMode==='hold',urgent=exits.some(e=>['TAKE PROFIT','CUT LOSS','SELL NOW'].includes(e.action)||e.notice);
  const sp=(x:number|null|undefined)=>x==null?'—':`${x>=0?'+':'−'}${Math.abs(x*100).toFixed(0)}%`;
  const noticeStyle:Record<string,string>={yes:'border-yes/40 bg-yes-dim/30',warn:'border-warn/40 bg-warn-dim/30',no:'border-no/40 bg-no-dim/30'};
  return <Card className={cn('rise',urgent?'border-warn/50':'border-info/30')}><Heading icon={<Wallet aria-hidden className="size-4 text-info"/>} title="Your positions · exit plan" aside={s?.config?.exitMode==='hold'?`hold to settlement · ${synced}`:s?.config?.exitMode==='ev'?'expected-value mode':`ride from +${Math.round((s?.config?.takeProfitPct??.25)*100)}% · trail ${Math.round((s?.config?.trailGiveback??.5)*100)}% give-back · stop −${Math.round((s?.config?.stopLossPct??.5)*100)}% or < ${Math.round((s?.config?.stopWinProb??.25)*100)}%`}/>
    {exits.map(e=>{const pnlTone:Tone=e.unrealized>0.005?'yes':e.unrealized<-0.005?'no':'neutral',t=hold&&e.action==='HOLD'?pnlTone:tones[e.action]??'neutral',[why,plan]=String(e.reason).split(' Plan: ');return <div key={e.ticker} className="mt-4 grid gap-4 border-t border-line pt-4 first-of-type:border-0 first-of-type:pt-0 lg:grid-cols-[1fr_auto]">
      <div><div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><div className={cn('font-display text-5xl leading-none font-bold uppercase',toneText[t],e.action==='TOO LATE'&&'text-muted')}>{e.action}</div>
        {e.unrealized!=null&&e.action!=='SETTLING'?<div className={cn('num text-2xl font-semibold',toneText[pnlTone])}>{e.unrealized>=0?'UP':'DOWN'} {signedDollars(e.unrealized)} <span className="text-base">({sp(e.unrealizedPct)})</span></div>:null}</div><div className="mt-2 text-sm"><span className="num">{qty(e.contracts)}</span> {e.side.toUpperCase()} · cost <span className="num">{cents(e.avgCost)}</span>{e.costSource==='exposure'?' (before fees)':' incl. fees'}{e.costSource==='estimate'?<span className="text-faint"> (fee estimated)</span>:null} · win chance <span className="num">{pct(e.winProb,0)}</span> <span className="num ml-1 text-xs text-faint">{e.ticker}</span></div>
        {e.action!=='SETTLING'&&(e.peakPct!=null||e.entryWinProb!=null)?<div className="mt-1 text-xs text-muted">Best {sp(e.peakPct)} · worst {sp(e.troughPct)} so far{e.entryWinProb!=null?<> · win chance {pct(e.winProb,0)} (was {pct(e.entryWinProb,0)} when you bought)</>:null}</div>:null}
        {e.notice?<div role="status" className={cn('mt-3 rounded-xl border px-3 py-2 text-sm',noticeStyle[e.notice.tone])}><div className={cn('font-medium',toneText[e.notice.tone as Tone])}>{e.notice.title}</div><div className="text-fg/85">{e.notice.text}</div></div>:null}
        <p className="mt-2 text-sm text-fg/90">{why}</p>
        {plan&&e.action!=='SETTLING'?<div className="mt-2 flex flex-wrap gap-2 text-xs">{e.trailBid!=null?<Pill tone="yes">Trailing stop at bid ≤ {cents(e.trailBid)} · peak {e.peakPct>=0?'+':''}{Math.round((e.peakPct??0)*100)}%</Pill>:<><Pill tone="yes">Ride from bid ≥ {cents(e.takeProfitBid)}</Pill><Pill tone="no">Cut loss at bid ≤ {cents(e.stopBid)}</Pill></>}<Pill tone="neutral">or win chance &lt; {Math.round((s?.config?.stopWinProb??.25)*100)}%</Pill></div>:null}</div>
      <div className="grid grid-cols-3 gap-5 self-start text-right"><Stat label="P&L if sold" tone={e.unrealized>0?'yes':e.unrealized<0?'no':'neutral'} sub={e.unrealizedPct!=null?`${e.unrealizedPct>=0?'+':'−'}${Math.abs(e.unrealizedPct*100).toFixed(0)}% of cost`:undefined}>{signedDollars(e.unrealized)}</Stat><Stat label="Sell now" sub={`bid ${cents(e.bid)} − ${dollars(e.sellFee)} fee`}>{dollars(e.sellValue)}</Stat><Stat label="Hold value" sub="forecast × $1">{dollars(e.holdValue)}</Stat></div></div>;})}
    <p className="mt-4 text-xs text-faint">{hold?'Hold mode keeps the position to settlement but calls out big moves: a gain past the ride level, giving back half of it, a loss past the cut-loss level, or the win chance falling 25 points. Risk mode in Settings turns those into TAKE PROFIT / CUT LOSS calls. ':'Exits use your real cost after fees. RIDE = winning past the arm level; the trailing stop follows your best gain. '}{exitVerdict(s?.backtest??null)??'Exits manage risk; they do not create edge.'} Change the exit style in Settings.</p></Card>;
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

export function Tactics({s,fresh}:{s:any;fresh:boolean}){
  const t=fresh?s?.tactics:null,ideas:any[]=t?.ideas??[],watch:any[]=t?.dips??[],cfg=s?.config;
  return <div className="space-y-3">
    {ideas.length?ideas.map(i=><div key={i.kind+i.side} className={cn('rounded-xl border p-4',i.side==='yes'?'border-yes/35 bg-yes-dim/30':'border-no/35 bg-no-dim/30')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><div className="font-display text-2xl font-bold uppercase">{i.kind==='scalp'?'Scalp':'Buy the dip'} · {i.side.toUpperCase()}</div><div className="num text-lg text-yes">{signedCents(i.profitAtTarget)}<span className="ml-1 text-xs text-muted">at target</span></div></div>
      <div className="mt-2 grid grid-cols-3 gap-3 text-sm"><div><div className="label">Buy at</div><div className="num">{cents(i.price)}</div></div><div><div className="label">Sell limit</div><div className="num">{cents(i.target)}</div></div><div><div className="label">Bail below</div><div className="num">{cents(i.stopBelow)}</div></div></div>
      <p className="mt-2 text-xs text-muted">{i.reason}</p>{i.belowMinSize?<p className="mt-1 text-xs text-info">Below 1 contract at your risk settings — paper only.</p>:<p className="mt-1 text-xs text-muted">{i.contracts} contracts suggested</p>}</div>)
    :<p className="text-sm text-muted">{!t?'Waiting for live data.':!t.live?'Paused (guardrail, data or market state).':`No setup now. Scalps need ≥ ${cents(cfg?.scalpMinEdge,0)} after fees, ≥ ${Math.round((cfg?.scalpMinSeconds??180)/60)} min left and a tight spread.`}</p>}
    {watch.map(w=><div key={w.side} className={cn('flex items-start gap-2 rounded-xl border px-3 py-2 text-sm',w.verdict==='buy'?'border-yes/30':'border-warn/35 bg-warn-dim/30')}><TrendingDown aria-hidden className={cn('mt-0.5 size-4 shrink-0',w.verdict==='buy'?'text-yes':'text-warn')}/>
      <span>{w.side.toUpperCase()} dropped {cents(w.drop)} ({cents(w.from)} → {cents(w.to)}) in a minute. {w.verdict==='buy'?'Fair value barely moved — likely overreaction.':`Fair value fell ${cents(Math.max(0,w.fairDrop))} too — falling knife, don't catch it.`}</span></div>)}
    <p className="text-xs text-faint">Every setup is paper-traded (target hit before close, else held to settlement) and scored on the Calibration page. Scalp and dip setups are not in the backtest: it needs second-by-second fills, so only their paper results count as evidence.</p></div>;
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
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs"><dt className="text-muted">Kalshi stream</dt><dd className="num text-right">{s?.kalshi?.status??'—'} · {s?.kalshi?.lag==null?'n/a':`${Math.round(s.kalshi.lag)}ms`}</dd><dt className="text-muted">Engine loop</dt><dd className="num text-right">{s?.loopMs?.toFixed(1)??'—'}ms</dd><dt className="text-muted">Data age on screen</dt><dd className="num text-right">{age==null?'—':ago(Math.max(0,age))}</dd><dt className="text-muted">Server clock offset</dt><dd className="num text-right">{s?.kalshi?.clockOffset?.toFixed(0)??'—'}ms</dd><dt className="text-muted">σ per √s (horizon-scaled)</dt><dd className="num text-right">{s?.sigma?(s.sigma*100).toFixed(5)+'%':'—'}</dd><dt className="text-muted">Variance ratio</dt><dd className="num text-right">×{s?.vol?.varianceRatio?.toFixed(2)??'—'}{s?.vol?.varianceRatioLive!=null?` (last hour ${s.vol.varianceRatioLive.toFixed(2)})`:''}</dd></dl>
    <p className="text-xs text-faint">A venue is live while its link answers within {s?.config?.staleMs??2000}ms (pinged every second) and its last quote is under 15 s old. Venues only send quotes when prices change.</p>
    {s?.account?.error?<p className="text-xs text-warn">{s.account.error}</p>:null}</div>;
}

export const icons={Gauge,BookOpen,Layers,Activity,ShieldCheck};

/** Tiny dependency-free sparkline for 0–1 series (rolling hit rates). */
function Spark({values,tone}:{values:(number|null)[];tone:string}){
  const pts=values.map((v,i)=>v==null?null:[i/(Math.max(1,values.length-1))*100,(1-v)*24] as const).filter(Boolean) as (readonly [number,number])[];
  if(pts.length<2)return null;
  return <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-24" aria-hidden><line x1="0" x2="100" y1="12" y2="12" className="stroke-line-strong" strokeDasharray="2 2" strokeWidth="1"/><polyline points={pts.map(p=>p.join(',')).join(' ')} fill="none" className={tone} strokeWidth="1.75" vectorEffect="non-scaling-stroke"/></svg>;
}
const mark=(c:any,result:string|null)=>{if(!c)return <span className="text-faint">—</span>;const ok=result?(c.direction==='UP')===(result==='yes'):null;
  return <span className="inline-flex items-center gap-1"><span className={c.direction==='UP'?'text-yes':'text-no'}>{c.direction==='UP'?'▲':'▼'}{pct(c.direction==='UP'?c.p:1-c.p,0)}</span>{ok===null?null:ok?<Check aria-label="right" className="size-3.5 text-yes"/>:<X aria-label="wrong" className="size-3.5 text-no"/>}</span>;};
export function RecentRounds({s}:{s:any}){
  const rounds:any[]=s?.calibration?.rounds??[],t=s?.calibration?.roundTrends,cur=s?.market?.ticker;
  const chips=[{key:'opening',label:'Opening call',tone:'stroke-info'},{key:'live300',label:'Call at 5:00',tone:'stroke-yes'},{key:'live60',label:'Call at 1:00',tone:'stroke-yes'},{key:'next5',label:'Next-window preview',tone:'stroke-warn'}];
  if(!rounds.length)return <p className="text-sm text-muted">Rounds appear here as they are called and settled.</p>;
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{chips.map(c=>{const tot=t?.totals?.[c.key];return <div key={c.key} className="rounded-xl border border-line bg-surface-2/50 p-3">
      <div className="label">{c.label}</div><div className="mt-1 flex items-end justify-between gap-2"><div><span className="num text-xl">{tot?.n?pct(tot.rate,0):'—'}</span><span className="ml-1.5 text-xs text-muted">{tot?.hits??0}/{tot?.n??0} right</span></div><Spark values={(t?.rolling??[]).map((r:any)=>r[c.key])} tone={c.tone}/></div>
      <div className="mt-0.5 text-xs text-muted">last 10: <span className="num text-fg">{pct(tot?.last10,0)}</span>{tot?.brier!=null?<> · Brier <span className="num">{tot.brier.toFixed(3)}</span></>:null}</div></div>;})}</div>
    <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Round','Result','Opening call','At 5:00','At 1:00','Preview (from prior round)','Your P&L'].map(h=><th key={h} scope="col" className="pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
      <tbody>{rounds.slice(0,16).map(r=><tr key={r.ticker} className={cn('border-t border-line',r.ticker===cur&&'bg-info/5')}>
        <td className="py-2 pr-3"><div className="num">{r.open?new Date(r.open).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):r.ticker.slice(-13)}</div>{r.ticker===cur?<div className="text-xs text-info">live now</div>:null}</td>
        <td className="pr-3">{r.result?<Pill tone={r.result==='yes'?'yes':'no'}>{r.result==='yes'?'UP':'DOWN'}</Pill>:<span className="text-xs text-muted">{r.ticker===cur?'running':'pending'}</span>}</td>
        <td className="pr-3">{mark(r.opening,r.result)}</td><td className="pr-3">{mark(r.live['300'],r.result)}</td><td className="pr-3">{mark(r.live['60'],r.result)}</td><td className="pr-3">{mark(r.next['5']??r.next['10'],r.result)}</td>
        <td className={cn('num',r.userPnl>0?'text-yes':r.userPnl<0?'text-no':'text-faint')}>{r.userPnl==null?'—':signedDollars(r.userPnl)}</td></tr>)}</tbody></table></div>
    <p className="text-xs text-faint">✓/✗ compare each call's direction with Kalshi's official result. Sparklines show the rolling 10-round hit rate (dashed line = 50%). Opening calls are near coin flips by design; late calls know most of the settlement average.</p></div>;
}
