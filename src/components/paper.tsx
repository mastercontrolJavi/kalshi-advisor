'use client';
import {useEffect,useMemo,useState,type FormEvent,type ReactNode} from 'react';
import dynamic from 'next/dynamic';
import {ChartCandlestick,GraduationCap,History,BookOpen,Wallet,ExternalLink,TriangleAlert,LineChart as ChartIcon,RotateCcw,Bitcoin,ChevronDown} from 'lucide-react';
import {useLive} from './use-live';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Pill,Kpi,Empty,Collapsible,Heading,SetupReadout,DelayNote,WindowBar,ForecastPanel,Instruments,toneText,type Tone} from './panels';
import {SectionHelp} from './section-help';
import {PanelBoundary} from './panel-boundary';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,cents,signedCents,pct,qty,mmss} from './format';
import {quoteOrder,type Side} from '@/engine/sim';
import {baseFees} from '@/engine/model/fees';
import type {ChartMark} from './price-chart';
import {useFlash,useCountUp,useEntrance} from './motion';
const PriceChart=dynamic(()=>import('./price-chart'),{ssr:false,loading:()=><div className="chart-tall animate-pulse rounded-xl bg-surface-2"/>});
const EquityChart=dynamic(()=>import('./analytics-charts').then(m=>m.EquityChart),{ssr:false});
const MAX_STAKE=.05;
async function post(path:string,body:unknown){
  const r=await fetch(`/api/engine/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error??`Request failed (HTTP ${r.status})`);return d;
}
/** The coach's report, refetched whenever the paper account changes (a fill, a reset, a settled round). */
function useReport(version:number|undefined){
  const [report,setReport]=useState<any>(null),[error,setError]=useState('');
  useEffect(()=>{let stop=false;
    fetch('/api/engine/sim/report',{cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}).then(d=>{if(!stop){setReport(d);setError('');}}).catch(e=>{if(!stop)setError((e as Error).message);});
    return()=>{stop=true;};},[version]);
  return {report,error};
}
const VERDICT:Record<string,{label:string;tone:Tone;text:string}>={
  good:{label:'Good call',tone:'yes',text:'Sound decision, and it paid.'},
  unlucky:{label:'Unlucky',tone:'neutral',text:'Sound decision that lost: repeat it.'},
  lucky:{label:'Lucky',tone:'warn',text:'It paid, but the decision was unsound: don’t repeat it.'},
  mistake:{label:'Mistake',tone:'no',text:'Unsound decision, and it lost.'},
  open:{label:'Open',tone:'neutral',text:'Waiting for the round to settle.'},
};
const LEARN:Record<string,{title:string;href:string}[]>={
  selection:[{title:'Efficient markets',href:'https://www.investopedia.com/terms/e/efficientmarkethypothesis.asp'}],
  price:[{title:'Expected value',href:'https://www.investopedia.com/terms/e/expected-value.asp'}],
  sizing:[{title:'Kelly criterion',href:'https://www.investopedia.com/terms/k/kellycriterion.asp'},{title:'Risk of ruin',href:'https://www.investopedia.com/terms/r/risk-of-ruin.asp'}],
  flips:[{title:'Sunk cost',href:'https://www.investopedia.com/terms/s/sunkcost.asp'}],
  earlyExit:[{title:'Expected value',href:'https://www.investopedia.com/terms/e/expected-value.asp'}],
  tilt:[{title:'Behavioral finance',href:'https://www.investopedia.com/terms/b/behavioralfinance.asp'}],
  fees:[],
};
const ext={target:'_blank',rel:'noreferrer'} as const;
function LearnLinks({cause}:{cause:string}){const links=LEARN[cause]??[];return links.length?<span className="flex flex-wrap gap-x-3">{links.map(l=><a key={l.href} href={l.href} {...ext} className="inline-flex items-center gap-1 text-xs text-info hover:underline">{l.title}<ExternalLink aria-hidden className="size-3"/></a>)}</span>:null;}

export default function Paper(){
  const {state:s,connected,fresh}=useLive(),sim=s?.sim,account=sim?.account??null,{report,error:reportError}=useReport(sim?.version);
  const coach=report?.coach??null,entrance=useEntrance<HTMLDivElement>();
  const pnl=account&&sim?.equity!=null?sim.equity-account.bankroll:null;
  const marks=useMemo<ChartMark[]>(()=>{const t=s?.market?.ticker;if(!t||!coach)return [];
    // Fills on the current round only, from the open review (reviews carry no fills; the position does).
    return (report?.fills??[]).filter((f:any)=>f.ticker===t).map((f:any)=>({time:f.time,price:f.price,side:f.side,action:f.action,contracts:f.contracts}));},[s?.market?.ticker,report,coach]);
  return <>
    <div aria-hidden className="ambient" data-tone={!fresh?'warn':'none'}/>
    <SiteHeader current="/paper" bottom={<WindowBar s={s}/>} aside={<span className="num hidden truncate text-xs text-muted xl:inline">{s?.market?.ticker??'waiting for market'}</span>}>
      <Pill tone="warn" title="Paper money: nothing here touches your Kalshi account">Paper money</Pill>
      <Pill tone={fresh?'yes':'warn'}><span className={fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{fresh?'Live':connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main ref={entrance} className="mx-auto max-w-[1600px] space-y-4 px-4 pt-4 pb-16 sm:px-6 3xl:max-w-[2400px] 4xl:max-w-[3200px]">
      {!fresh?<div role="status" className="rounded-xl border border-warn/40 bg-warn-dim/30 px-4 py-2 text-sm text-warn">{connected?'Updates are stale':'Reconnecting to the engine'} · paper orders paused until live prices are back.</div>:null}
      {!s?null:!account?<StartAccount/>:<>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Paper equity" sub={`started with ${dollars(account.bankroll,0)}`}>{dollars(sim.equity)}</Kpi>
          <Kpi label="Paper P&L" className={pnl!=null?toneText[pnl>0?'yes':pnl<0?'no':'neutral']:''} sub={pnl!=null?`${pct(pnl/account.bankroll)} of the bankroll`:undefined}>{signedDollars(pnl)}</Kpi>
          <Kpi label="Cash" sub={sim.positions?.length?`${sim.positions.length} open position${sim.positions.length>1?'s':''}`:'no open position'}><CountUp value={sim.cash} format={v=>dollars(v)}/></Kpi>
          <Kpi label="Rounds" sub={sim.rounds?`${pct(sim.wins/sim.rounds,0)} won`:'none settled yet'}>{sim.rounds} settled</Kpi>
          <Kpi label="Sound decisions" sub={coach?.settled?`${coach.verdicts.good+coach.verdicts.unlucky} of ${coach.settled} rounds`:'graded once rounds settle'}>{coach?.settled?pct((coach.verdicts.good+coach.verdicts.unlucky)/coach.settled,0):'—'}</Kpi>
          <Kpi label="Fees paid" sub="Kalshi’s taker fee, as on real trades">{dollars(sim.fees)}</Kpi>
        </div>
        <Instruments s={s} paper/>
        {/* Same working areas as the 15-min page: the chart sets the row height and the ticket (and, from 1920 px, the calls
            and coach) scroll inside it, so a new position never pushes the rest of the page down. */}
        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="min-w-0 p-0 lg:col-span-8 3xl:col-span-6">
            <div className="flex min-h-12 items-center gap-2 border-b border-line px-4 py-2"><ChartCandlestick aria-hidden className="size-4 text-info"/><h2 className="font-medium">Price action</h2><SectionHelp title="Price action"/><span className="ml-auto hidden text-xs text-muted sm:inline">your paper fills are marked on the Kalshi candles</span></div>
            <div className="p-4"><PanelBoundary name="Price chart"><PriceChart s={s} fresh={fresh} marks={marks}/></PanelBoundary></div>
          </Card>
          <div className="relative min-w-0 lg:col-span-4 3xl:col-span-3"><div className="flex flex-col gap-4 lg:absolute lg:inset-0 lg:overflow-y-auto lg:pr-1 lg:[scrollbar-gutter:stable]"><Ticket s={s} fresh={fresh}/></div></div>
          <div className="relative min-w-0 lg:col-span-12 3xl:col-span-3"><div className="flex flex-col gap-4 3xl:absolute 3xl:inset-0 3xl:overflow-y-auto 3xl:pr-1 3xl:[scrollbar-gutter:stable]"><ForecastPanel s={s} fresh={fresh}/><Coach report={report} error={reportError}/></div></div>
        </div>
        {(sim.positions??[]).some((p:any)=>p.ticker!==s?.market?.ticker)?<Collapsible open title="Other paper positions" icon={<Wallet aria-hidden className="size-4 text-info"/>} aside="earlier rounds, settled on Kalshi's result"><OtherPositions s={s} fresh={fresh}/></Collapsible>:null}
        <Collapsible open title="Paper rounds" icon={<History aria-hidden className="size-4 text-info"/>} aside={coach?.settled?`${coach.settled} settled · ${signedDollars(coach.net)}`:'every round, graded'}><Rounds coach={coach}/></Collapsible>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Collapsible open title="Paper equity" icon={<ChartIcon aria-hidden className="size-4 text-info"/>} aside={coach?.drawdown?`deepest drop ${dollars(coach.drawdown)}`:'after each settled round'}>
            {report?.equity?.length>1?<PanelBoundary name="Equity chart"><EquityChart data={report.equity.map((e:any)=>({time:e.time,pnl:e.equity-account.bankroll}))}/></PanelBoundary>:<Empty>The curve starts after your first settled round.</Empty>}
          </Collapsible>
          <Collapsible open title="Learn the ideas behind the coach" icon={<BookOpen aria-hidden className="size-4 text-info"/>} aside="7 short reads"><Learn/></Collapsible>
        </div>
        <Collapsible title="Paper account" icon={<Wallet aria-hidden className="size-4 text-info"/>} aside={`started ${new Date(account.time).toLocaleDateString([],{month:'short',day:'numeric'})} · ${report?.accounts??1} account${(report?.accounts??1)>1?'s':''} so far`}><Reset account={account}/></Collapsible>
      </>}
    </main>
  </>;
}
function CountUp({value,format}:{value:number|null|undefined;format:(v:number)=>string}){const ref=useCountUp(value,format);return <span ref={ref}/>;}

function StartAccount(){
  const [bankroll,setBankroll]=useState('1000'),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function start(){setBusy(true);setMessage('');try{await post('sim/reset',{bankroll:Number(bankroll)});}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
  return <Card className="rise mx-auto max-w-2xl space-y-4">
    <div className="label">Paper trading</div>
    <h1 className="font-display text-4xl font-bold uppercase sm:text-5xl">Trade the live round with paper money</h1>
    <p className="text-[15px] text-fg/90">Same Kalshi round, same live order book, same taker fee. Orders fill against the real bids and asks the moment you click, and settle on Kalshi’s real result. Nothing touches your Kalshi account.</p>
    <p className="text-sm text-muted">After each round the coach grades the decision, not the result, and adds up which habits make or lose money, with the fix for each.</p>
    <div className="flex flex-wrap items-end gap-3"><label htmlFor="paper-bankroll" className="block min-w-48 flex-1 space-y-1"><span className="text-sm">Starting paper bankroll ($)</span><Input id="paper-bankroll" type="number" inputMode="decimal" min={1} step="any" value={bankroll} onChange={e=>setBankroll(e.target.value)}/></label>
      <Button disabled={busy||!(Number(bankroll)>=1)} onClick={()=>void start()}>{busy?'Starting…':'Start paper trading'}</Button></div>
    <p role="status" className="text-sm text-no">{message}</p>
  </Card>;
}

/** Kalshi-style price: 98.1¢, but 2¢ rather than 2.0¢. */
const price=(v:number|null|undefined)=>cents(v,v!=null&&Math.round(v*1000)%10?1:0);
/** Kalshi-style dollars: $21, or $20.37 when there are cents. */
const payout=(v:number|null|undefined)=>dollars(v??0,v!=null&&Math.round(v*100)%100?2:0);
/** The order ticket, laid out like Kalshi's own trade view: buy or sell, UP or DOWN, an amount, then review and submit. */
function Ticket({s,fresh}:{s:any;fresh:boolean}){
  const sim=s?.sim,[action,setAction]=useState<'buy'|'sell'>('buy'),[side,setSide]=useState<Side>('yes'),[mode,setMode]=useState<'dollars'|'contracts'>('dollars');
  const [buyAmount,setBuyAmount]=useState('20'),[sellAmount,setSellAmount]=useState(''),[review,setReview]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState<{ok:boolean;text:string}|null>(null);
  const market=s?.market,tau=Math.max(0,s?.tau??0),book=s?.book,q=s?.quant?.p??null,equity=sim?.equity??0,cash=sim?.cash??0;
  const schedule={...baseFees,...(s?.kalshi?.fees??{}),precision:s?.config?.feePrecision??.0001};
  const pos=(sim?.positions??[]).find((p:any)=>p.ticker===market?.ticker)??null,selling=action==='sell',unit=selling?'contracts':mode;
  // A sale defaults to everything held; a buy keeps the amount last typed.
  const amount=selling?sellAmount||(pos?String(pos.contracts):''):buyAmount,setAmount=selling?setSellAmount:setBuyAmount;
  const amt=Number(amount),levels=book?{yes:book.yes??[],no:book.no??[]}:null,held=pos&&pos.side===side?pos:null;
  const preview=!levels||!(amt>0)?null:selling?(held?quoteOrder(levels,side,'sell',{contracts:Math.min(amt,held.contracts)},schedule):null)
    :quoteOrder(levels,side,'buy',mode==='dollars'?{dollars:Math.min(amt,cash)}:{contracts:amt,dollars:cash},schedule);
  const fair=q===null?null:side==='yes'?q:1-q,edge=!selling&&preview?.contracts&&fair!==null?fair-preview.price-preview.fee/preview.contracts:null,stake=!selling&&preview&&equity>0?preview.cash/equity:null;
  const quote=(x:Side)=>selling?(x==='yes'?book?.yesBid:book?.noBid):(x==='yes'?book?.yesAsk:book?.noAsk),chance=preview?.contracts?preview.price:quote(side);
  const word=side==='yes'?'UP':'DOWN',verb=selling?'Sell':'Buy',close=market?new Date(market.close_time):null;
  const closed=!fresh?'Live prices unavailable':!market?'No round is open':tau<=1?'Round closed':s?.kalshi?.delayed?'Kalshi prices delayed':null;
  const blocked=closed??(selling&&!held?`No ${word} contracts to sell`:null);
  const flash=useFlash<HTMLDivElement>(status?.text);
  useEffect(()=>{setReview(false);},[market?.ticker,action,side]);
  async function send(body:any){setBusy(true);setStatus(null);try{const d=await post('sim/order',body);setStatus({ok:true,text:d.message});setReview(false);if(body.action==='sell')setSellAmount('');}catch(e){setStatus({ok:false,text:(e as Error).message});}finally{setBusy(false);}}
  // Enter or "Review" shows the fill first; "Submit" sends it at the live book, as Kalshi's own two-step ticket does.
  function submit(e:FormEvent){e.preventDefault();if(busy||blocked||!preview?.contracts)return;if(!review){setReview(true);return;}void send({side,action,[unit]:amt});}
  const tab=(on:boolean)=>cn('font-display min-h-12 cursor-pointer border-b-2 text-lg font-bold tracking-wide uppercase transition-colors',on?'border-fg text-fg':'border-transparent text-faint hover:text-muted');
  const chip='inline-flex min-h-8 cursor-pointer items-center rounded-full px-2.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg';
  return <Card ref={flash} className={cn('rise relative p-0',pos?(pos.side==='yes'?'border-yes/40':'border-no/40'):'')}>
    <form onSubmit={submit}>
    <div className="flex items-center justify-between gap-3 border-b border-line px-5">
      <div role="group" aria-label="Order" className="flex gap-5">{(['buy','sell'] as const).map(a=><button key={a} type="button" aria-pressed={action===a} onClick={()=>{setAction(a);if(a==='sell'&&pos)setSide(pos.side);}} className={tab(action===a)}>{a}</button>)}</div>
      <label className="relative flex items-center"><span className="sr-only">Amount in</span>
        <select value={unit} disabled={selling} onChange={e=>setMode(e.target.value as 'dollars'|'contracts')} className="font-display min-h-11 cursor-pointer appearance-none bg-transparent pr-6 text-right text-lg font-bold tracking-wide text-fg uppercase disabled:cursor-default disabled:text-muted"><option value="dollars">Dollars</option><option value="contracts">Contracts</option></select>
        <ChevronDown aria-hidden className="pointer-events-none absolute right-0 size-4"/></label>
    </div>
    <div className="space-y-5 p-5">
      <div className="flex items-center gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-warn text-bg"><Bitcoin aria-hidden className="size-6"/></span>
        <h2 className="font-display min-w-0 text-2xl leading-tight font-bold">BTC 15 min · {s?.K!=null?<span className="num">{dollars(s.K)} target</span>:'target pending'}</h2><span className="ml-auto"><SectionHelp title="Paper ticket"/></span></div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Side" className="flex rounded-full border border-line bg-surface-2/70 p-1">{(['yes','no'] as Side[]).map(x=>{const on=side===x;
          return <button key={x} type="button" role="radio" aria-checked={on} disabled={selling&&!!pos&&pos.side!==x} onClick={()=>setSide(x)} className={cn('font-display num min-h-11 cursor-pointer rounded-full px-5 text-lg font-bold tracking-wide uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40',on?(x==='yes'?'bg-yes text-bg':'bg-no text-bg'):'text-fg hover:bg-surface')}>{x==='yes'?'Up':'Down'} {price(quote(x))}</button>;})}</div>
        <span className={cn('num text-[15px] underline decoration-dotted underline-offset-4',tau<=60&&market?'text-warn':'text-muted')} aria-label={market?`${mmss(tau)} left in the round`:'No round open'}>{market?`${mmss(tau)} left`:'no round'}</span>
      </div>
      <DelayNote s={s}>Paper orders wait until the feed catches up, so every fill is one you could really have got.</DelayNote>
      <label className="flex min-h-16 cursor-text items-center justify-between gap-3 rounded-[14px] border border-line-strong bg-bg/70 px-4 transition-colors focus-within:border-info hover:border-faint">
        <span className="text-[17px] text-muted">{unit==='dollars'?'Dollars':'Contracts'}</span>
        <span className="flex min-w-0 items-baseline">{unit==='dollars'?<span className={cn('font-display text-3xl font-bold',amt>0?'text-fg':'text-faint')}>$</span>:null}
          <input type="number" inputMode="decimal" min={0} step="any" placeholder="0" value={amount} onChange={e=>{setAmount(e.target.value);setReview(false);}} style={{width:`calc(${Math.min(10,Math.max(1,amount.length))}ch + 2px)`}} className="num font-display min-w-0 bg-transparent text-right text-3xl font-bold text-fg outline-none placeholder:text-faint [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"/></span>
      </label>
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[15px] text-muted">Paper account · {selling?(pos?`${qty(pos.contracts)} ${pos.side==='yes'?'UP':'DOWN'} held`:'nothing held this round'):`${dollars(cash)} available`}</span>
        {!selling&&mode==='dollars'?<span className="flex gap-0.5">{[.01,.02,.05].map(f=><button key={f} type="button" onClick={()=>{setBuyAmount(String(Math.max(1,Math.floor(equity*f))));setReview(false);}} className={chip}>{pct(f,0)}</button>)}</span>:null}
      </div>
      {review&&preview?.contracts?<div className="rounded-xl border border-line bg-surface-2/60 p-4">
        <div className="label">Review your paper order</div>
        <div className={cn('font-display mt-1 text-3xl font-bold uppercase',side==='yes'?'text-yes':'text-no')}>{verb} {qty(preview.contracts)} {word}</div>
        <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-sm">
          <dt className="text-muted">Average price</dt><dd className="num text-right">{cents(preview.price)}{preview.levels>1?` · ${preview.levels} levels`:''}</dd>
          <dt className="text-muted">Fee</dt><dd className="num text-right">{dollars(preview.fee)}</dd>
          {selling&&held?<>
            <dt className="text-muted">You receive</dt><dd className="num text-right">{dollars(preview.cash)}</dd>
            <dt className="text-muted">P&L on these</dt><dd className={cn('num text-right',preview.cash-preview.contracts*held.avgCost>=0?'text-yes':'text-no')}>{signedDollars(preview.cash-preview.contracts*held.avgCost)}</dd>
            <dt className="text-muted">Hold value at the forecast</dt><dd className="num text-right">{dollars(held.holdValue*preview.contracts/held.contracts)}</dd>
          </>:<>
            <dt className="text-muted">Total cost</dt><dd className="num text-right">{dollars(preview.cash)}</dd>
            <dt className="text-muted">Payout if {word}</dt><dd className="num text-right text-yes">{dollars(preview.contracts)} ({signedDollars(preview.contracts-preview.cash)})</dd>
            <dt className="text-muted">Edge after fee</dt><dd className={cn('num text-right',edge==null?'':edge>=0?'text-yes':'text-no')}>{edge==null?'—':`${signedCents(edge)} a contract`}</dd>
            <dt className="text-muted">Of your equity</dt><dd className={cn('num text-right',stake!=null&&stake>MAX_STAKE?'text-warn':'')}>{stake==null?'—':pct(stake,1)}</dd>
          </>}
        </dl>
        {preview.partial?<p className="mt-2 text-xs text-warn">Only {qty(preview.contracts)} fill at the bids showing now.</p>:null}
      </div>:<dl className="space-y-3">
        <div className="flex items-center justify-between gap-3"><dt className="text-[17px] text-muted">Odds</dt><dd className="num text-xl">{chance==null?'—':`${pct(chance,0)} chance`}</dd></div>
        <div className="flex items-end justify-between gap-3"><dt className="text-[17px] text-muted">{selling?'You receive':'Max payout'}{close?<span className="block text-[15px]">{close.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})} · {close.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span>:null}</dt>
          <dd className="num font-display text-5xl leading-none font-bold">{payout(selling?preview?.cash:preview?.contracts)}</dd></div>
      </dl>}
      {stake!=null&&stake>MAX_STAKE?<p className="-mt-2 flex items-start gap-1.5 text-xs text-warn"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0"/>Over {pct(MAX_STAKE,0)} of equity on one round: the coach will flag it.</p>:null}
      {edge!=null&&edge<0?<p className="-mt-2 flex items-start gap-1.5 text-xs text-warn"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0"/>Above the forecast after the fee: expected to lose {signedCents(edge).slice(1)} a contract.</p>:null}
      {review&&preview?.contracts?<div className="grid grid-cols-[auto_1fr] gap-2"><Button type="button" variant="outline" className="h-14 px-6" onClick={()=>setReview(false)}>Back</Button>
        <Button type="submit" className={cn('h-14 text-base',side==='no'&&'bg-no hover:bg-no/85')} disabled={busy||!!blocked}>{busy?'Sending…':blocked??`Submit ${verb.toLowerCase()}`}</Button></div>
        :<Button type="submit" className="h-14 w-full text-base" disabled={busy||!!blocked||!preview?.contracts}>{blocked??`Review ${verb}`}</Button>}
      <p role="status" className={cn('-mt-2 min-h-5 text-sm',status?(status.ok?'text-yes':'text-no'):'text-muted')}>{status?.text??''}</p>
    </div>
    </form>
    {pos?<div className="mx-5 mb-5 rounded-xl border border-line bg-surface-2/60 p-3">
      <div className="flex items-baseline justify-between gap-2"><span className="label">Your paper position</span><span className={cn('num text-lg font-semibold',pos.unrealized>0?'text-yes':pos.unrealized<0?'text-no':'')}>{signedDollars(pos.unrealized)}</span></div>
      <div className="mt-1 text-sm"><span className="num">{qty(pos.contracts)}</span> {pos.side==='yes'?'UP':'DOWN'} · avg <span className="num">{cents(pos.avgCost)}</span> incl. fees · bid <span className="num">{cents(pos.bid)}</span></div>
      <div className="mt-0.5 text-xs text-muted">Hold value at the forecast {dollars(pos.holdValue)} · sell now {dollars(pos.value)} before the fee</div>
      <Button variant="outline" size="sm" className="mt-3 w-full" disabled={busy||!!closed||pos.bid==null} onClick={()=>void send({side:pos.side,action:'sell',contracts:pos.contracts})}>{busy?'Sending…':`Sell all ${qty(pos.contracts)} at the bid`}</Button>
    </div>:null}
    {market?<div className="px-5 pb-5"><SetupReadout s={s}/></div>:null}
  </Card>;
}

function Coach({report,error}:{report:any;error:string}){
  const c=report?.coach,last=c?.reviews?.find((r:any)=>r.verdict!=='open')??null,flash=useFlash<HTMLDivElement>(c?.settled);
  const v=c?.verdicts??{good:0,unlucky:0,lucky:0,mistake:0},total=Math.max(1,(c?.settled??0));
  return <Card className="rise space-y-4">
    <Heading icon={<GraduationCap aria-hidden className="size-4 text-info"/>} title="Coach" aside={c?.settled?`${c.settled} settled rounds`:undefined}/>
    {error?<p className="text-sm text-warn">Coach unavailable ({error}).</p>:null}
    <p className="text-[15px] text-fg/90">{c?.headline??'Loading your paper record…'}</p>
    {c?.settled?<div><div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Good calls ${v.good}, unlucky ${v.unlucky}, lucky ${v.lucky}, mistakes ${v.mistake}`}>
        {([['good','bg-yes'],['unlucky','bg-info'],['lucky','bg-warn'],['mistake','bg-no']] as const).map(([k,cls])=>v[k]?<div key={k} className={cn('bar-fill h-full',cls)} style={{width:`${v[k]/total*100}%`}}/>:null)}</div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">{([['good','text-yes'],['unlucky','text-info'],['lucky','text-warn'],['mistake','text-no']] as const).map(([k,cls])=><span key={k}><span className={cn('num',cls)}>{v[k]}</span> {VERDICT[k].label.toLowerCase()}</span>)}</div></div>:null}
    {last?<div ref={flash} className="rounded-xl border border-line bg-surface-2/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="label">Last round</span><span className="flex items-center gap-2"><Pill tone={VERDICT[last.verdict].tone}>{VERDICT[last.verdict].label}</Pill><span className={cn('num',last.pnl>0?'text-yes':'text-no')}>{signedDollars(last.pnl)}</span></span></div>
      <p className="mt-1 text-xs text-muted">{VERDICT[last.verdict].text}</p>
      <ul className="mt-2 space-y-1 text-sm">{last.notes.map((n:string)=><li key={n}>{n}</li>)}</ul></div>:null}
    {c?.causes?.length?<section><div className="label">What it cost and how to fix it</div>
      <ul className="mt-2 space-y-2">{c.causes.map((x:any)=><li key={x.cause} className="rounded-xl border border-warn/30 bg-warn-dim/20 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium">{x.title}</span><span className="num text-sm text-no">{signedDollars(x.net)} · {x.rounds} round{x.rounds===1?'':'s'}</span></div>
        <p className="mt-1 text-sm text-fg/85"><span className="text-muted">Why: </span>{x.why}</p><p className="mt-1 text-sm"><span className="text-muted">Fix: </span>{x.fix}</p><div className="mt-1"><LearnLinks cause={x.cause}/></div></li>)}</ul></section>:null}
    {c?.working?.length||c?.notWorking?.length?<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2 3xl:grid-cols-1">
      <GroupList title="Working" tone="yes" groups={c.working} empty="Nothing has made money twice yet."/>
      <GroupList title="Not working" tone="no" groups={c.notWorking} empty="No losing pattern yet."/></div>:null}
    <p className="text-xs text-faint">Graded on the decision: price paid against the quant forecast after the fee, the setup’s record over 9,800 past rounds, bet size (≤ 5% of equity) and flips. A few rounds prove little; 20+ start to tell.</p>
  </Card>;
}
function GroupList({title,tone,groups,empty}:{title:string;tone:Tone;groups:any[];empty:string}){
  return <div><div className="label">{title}</div>{groups.length?<ul className="mt-1.5 space-y-1 text-sm">{groups.map(g=><li key={g.label} className="flex justify-between gap-2"><span className="min-w-0 truncate">{g.label}</span><span className={cn('num shrink-0',toneText[tone])}>{signedDollars(g.net)} <span className="text-xs text-muted">{g.wins}/{g.rounds}</span></span></li>)}</ul>:<p className="mt-1.5 text-sm text-muted">{empty}</p>}</div>;
}

function Rounds({coach}:{coach:any}){
  if(!coach?.reviews?.length)return <Empty>Your paper rounds appear here as you trade, each graded by the coach.</Empty>;
  const time=(t:number)=>new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  return <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Entered','Side','Setup','Paid','Forecast','Edge','Stake','Result','P&L','Verdict'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
    <tbody>{coach.reviews.map((r:any)=><tr key={r.ticker} className="border-t border-line align-top">
      <td className="num py-2 pr-3">{time(r.time)}</td><td className={cn('pr-3 py-2',r.side==='yes'?'text-yes':'text-no')}>{r.side.toUpperCase()}</td>
      <td className="pr-3 py-2">{r.entry.setup?<>{r.entry.setup.kind==='coinflip'?'Coin flip':r.entry.setup.kind}{r.entry.setup.kind!=='coinflip'?<span className="text-muted"> · {r.entry.setup.with?'with':'against'}</span>:null}</>:<span className="text-faint">—</span>}</td>
      <td className="num pr-3 py-2">{cents(r.entry.price)}</td><td className="num pr-3 py-2">{cents(r.entry.fair,0)}</td>
      <td className={cn('num pr-3 py-2',r.entry.edge==null?'':r.entry.edge>=0?'text-yes':'text-no')}>{signedCents(r.entry.edge)}</td>
      <td className={cn('num pr-3 py-2',r.stakePct!=null&&r.stakePct>MAX_STAKE?'text-warn':'')}>{pct(r.stakePct,1)}</td>
      <td className="pr-3 py-2">{r.result?<Pill tone={r.result==='yes'?'yes':'no'}>{r.result==='yes'?'UP':'DOWN'}</Pill>:<span className="text-xs text-muted">pending</span>}</td>
      <td className={cn('num pr-3 py-2',r.pnl>0?'text-yes':r.pnl<0?'text-no':'')}>{r.pnl==null?'—':signedDollars(r.pnl)}</td>
      <td className="py-2"><details><summary className="inline-flex"><Pill tone={VERDICT[r.verdict].tone}>{VERDICT[r.verdict].label}</Pill></summary><ul className="mt-2 max-w-sm space-y-1 text-xs text-muted">{r.notes.map((n:string)=><li key={n}>{n}</li>)}</ul></details></td></tr>)}</tbody></table></div>;
}

function Learn(){
  const items:{title:string;body:ReactNode;links:{title:string;href:string}[]}[]=[
    {title:'Expected value',body:'Each ticket shows the edge: the forecast minus the price minus the fee. A positive edge makes money over many rounds even when this one loses; a negative one loses over many rounds even when this one wins.',links:[{title:'Expected value',href:'https://www.investopedia.com/terms/e/expected-value.asp'}]},
    {title:'Decision, not result',body:'The coach grades the decision: a good call can lose (unlucky) and a bad one can win (lucky). A handful of rounds is mostly luck; the pattern shows after 20 or more.',links:[{title:'Law of large numbers',href:'https://www.investopedia.com/terms/l/lawoflargenumbers.asp'}]},
    {title:'Bet size',body:'Size to the edge. With no proven edge the right size is small: in the backtest, 2–10% stakes never went broke over 100 trades and 25% sometimes did.',links:[{title:'Kelly criterion',href:'https://www.investopedia.com/terms/k/kellycriterion.asp'},{title:'Risk of ruin',href:'https://www.investopedia.com/terms/r/risk-of-ruin.asp'}]},
    {title:'Efficient markets',body:'Kalshi’s price already includes the trend and the chart: over 9,800 past rounds nothing public beat it before the final minute. An edge has to come from price, not from reading the chart.',links:[{title:'Efficient markets',href:'https://www.investopedia.com/terms/e/efficientmarkethypothesis.asp'}]},
    {title:'Fees',body:'Kalshi charges 7% × contracts × price × (1 − price) on every buy and every sale: 1.75¢ a contract at 50¢, 0.6¢ at 90¢. A round-trip pays it twice.',links:[]},
    {title:'Behavioral traps',body:'Bigger bets after a loss (tilt) and buying the other side to win it back (sunk cost) are the two habits that most often turn a bad round into a bad day.',links:[{title:'Behavioral finance',href:'https://www.investopedia.com/terms/b/behavioralfinance.asp'},{title:'Sunk cost',href:'https://www.investopedia.com/terms/s/sunkcost.asp'}]},
    {title:'How a round settles',body:'YES pays $1 if the average of CF Benchmarks’ Bitcoin index (BRTI) over the last 60 s is at or above the opening price K. The last minute is averaged, so a late spike moves it less than it looks.',links:[{title:'BRTI',href:'https://www.cfbenchmarks.com/data/indices/BRTI'}]},
  ];
  return <ul className="grid gap-3 sm:grid-cols-2">{items.map(x=><li key={x.title} className="rounded-xl border border-line bg-surface-2/50 p-3"><div className="font-medium">{x.title}</div><p className="mt-1 text-sm text-muted">{x.body}</p>
    {x.links.length?<div className="mt-1.5 flex flex-wrap gap-x-3">{x.links.map(l=><a key={l.href} href={l.href} {...ext} className="inline-flex items-center gap-1 text-xs text-info hover:underline">{l.title}<ExternalLink aria-hidden className="size-3"/></a>)}</div>:null}</li>)}</ul>;
}

function Reset({account}:{account:any}){
  const [bankroll,setBankroll]=useState(String(account.bankroll)),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function reset(){setBusy(true);setMessage('');try{await post('sim/reset',{bankroll:Number(bankroll)});setConfirm(false);setMessage('New paper account started. The old one stays in the journal.');}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
  return <div className="space-y-3"><p className="text-sm text-muted">Starting over opens a new paper account with the bankroll below. Past accounts stay in the journal for later studies; the coach reviews the current one.</p>
    <div className="flex flex-wrap items-end gap-3"><label htmlFor="paper-reset" className="block min-w-48 space-y-1"><span className="text-sm">New paper bankroll ($)</span><Input id="paper-reset" type="number" inputMode="decimal" min={1} step="any" value={bankroll} onChange={e=>{setBankroll(e.target.value);setConfirm(false);}}/></label>
      {confirm?<Button variant="outline" disabled={busy} onClick={()=>void reset()}><RotateCcw aria-hidden className="size-4"/>{busy?'Starting…':`Confirm: start over with ${dollars(Number(bankroll),0)}`}</Button>
        :<Button variant="ghost" disabled={!(Number(bankroll)>=1)} onClick={()=>setConfirm(true)}><RotateCcw aria-hidden className="size-4"/>Start over</Button>}</div>
    <p role="status" className="text-sm text-muted">{message}</p></div>;
}

/** Paper positions outside the current Bitcoin round: an earlier round still waiting for its result. */
function OtherPositions({s,fresh}:{s:any;fresh:boolean}){
  const rows=(s?.sim?.positions??[]).filter((p:any)=>p.ticker!==s?.market?.ticker),[busy,setBusy]=useState(''),[status,setStatus]=useState<{ok:boolean;text:string}|null>(null);
  async function sell(p:any){setBusy(p.ticker);setStatus(null);try{const d=await post('sim/order',{ticker:p.ticker,side:p.side,action:'sell',contracts:p.contracts});setStatus({ok:true,text:d.message});}catch(e){setStatus({ok:false,text:(e as Error).message});}finally{setBusy('');}}
  return <div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Market','Side','Contracts','Avg cost','Bid now','If sold','Closes',''].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
    <tbody>{rows.map((p:any)=><tr key={p.ticker} className="border-t border-line/70">
      <th scope="row" className="max-w-[320px] py-2 pr-3 text-left font-normal"><div className="truncate font-medium">{p.title??p.ticker}</div><div className="text-xs text-muted">{p.ticker}</div></th>
      <td className={cn('pr-3',p.side==='yes'?'text-yes':'text-no')}>{p.side.toUpperCase()}</td><td className="num pr-3">{qty(p.contracts)}</td><td className="num pr-3">{cents(p.avgCost)}</td><td className="num pr-3">{cents(p.bid)}</td>
      <td className={cn('num pr-3',p.unrealized>0?'text-yes':p.unrealized<0?'text-no':'')}>{signedDollars(p.unrealized)}</td>
      <td className="pr-3 text-muted">{p.close?new Date(p.close).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—'}</td>
      <td className="py-1.5 text-right">{p.url?<a href={p.url} target="_blank" rel="noreferrer" className="mr-3 text-xs text-info hover:underline">Kalshi</a>:null}<Button size="sm" variant="outline" disabled={!fresh||busy===p.ticker||p.bid==null} onClick={()=>void sell(p)}>{busy===p.ticker?'Selling…':'Sell all'}</Button></td></tr>)}</tbody></table></div>
    <p role="status" className={cn('mt-2 min-h-5 text-sm',status?(status.ok?'text-yes':'text-no'):'')}>{status?.text??''}</p></div>;
}
