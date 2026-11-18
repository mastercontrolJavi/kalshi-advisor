'use client';
import {useCallback,useEffect,useState} from 'react';
import dynamic from 'next/dynamic';
import {RefreshCw} from 'lucide-react';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Button} from './ui/button';
import {Pill,Kpi,Empty} from './panels';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,signedCents,pct,cents,qty,mmss} from './format';
const Equity=dynamic(()=>import('./analytics-charts').then(m=>m.EquityChart),{ssr:false});
// The bot rewrites its status every 10 s; the record only changes when a round fills or settles.
const REFRESH_MS=10000;
/** Rounds needed before the per-contract result means anything (bot/README.md). */
const JUDGE_AT=300;
const tone=(v:number|null|undefined)=>v==null||v===0?'':v>0?'text-yes':'text-no';
const VERDICTS:Record<string,string>={
  'trade':'Buying','outside the trading window':'Outside its trading window','no edge after the fee':'No edge after the fee','mid band':'Price is in the middle band it skips',
  'ask outside the allowed prices':'Price is outside the range it trades','no ask':'No offer on the book','one contract is more than the risk cap':'One contract is more than it may risk',
  'bankroll below the bust level':'Bankroll too low to trade'};
function Now({s,off}:{s:any;off:boolean}){
  if(!s)return <Empty>The bot has not reported yet. It starts with the app; BOT=off in .env.local skips it.</Empty>;
  if(!s.running)return <Empty>The bot is not running (last report {new Date(s.time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}).</Empty>;
  const v=s.view,r=s.round,c=s.config,warm=!s.ready;
  // The side and edge come from the bot (the side its rule picked, else the one with the larger edge), never from which side the model favours.
  const side:'yes'|'no'|null=v?.side??null,edge:number|null=v?.edge??null;
  return <dl className="grid grid-cols-2 gap-y-2 text-sm">
    <dt className="text-muted">Round</dt><dd className="num text-right">{r?r.ticker.replace('KXBTC15M-',''):'none open'}</dd>
    <dt className="text-muted">Time left</dt><dd className="num text-right">{r?mmss((r.close-s.time)/1000):'—'}</dd>
    <dt className="text-muted">Target</dt><dd className="num text-right">{r?.strike?dollars(r.strike):'—'}</dd>
    <dt className="text-muted">Model: finishes above</dt><dd className="num text-right">{warm?`warming up ${s.warmup[0]}/${s.warmup[1]}`:pct(v?.pYes)}</dd>
    <dt className="text-muted">Ask, YES / NO</dt><dd className="num text-right">{cents(v?.yesAsk)} / {cents(v?.noAsk)}</dd>
    <dt className="text-muted">{side?`Best edge after fee: ${side.toUpperCase()}`:'Best edge after fee'}</dt><dd className={cn('num text-right',tone(edge))}>{warm?'—':signedCents(edge)}<span className="ml-1 text-xs text-muted">needs +{(c.minEdge*100).toFixed(0)}¢</span></dd>
    <dt className="text-muted">Decision</dt><dd className="text-right">{r?.held?'Holding this round to settlement':off?'Real trading is off: watching only':warm?'Collecting index prints first':v?(v.verdict==='trade'&&side?`Buying ${side.toUpperCase()}`:VERDICTS[v.verdict]??v.verdict):'Waiting for the book'}</dd>
    <dt className="text-muted">Kalshi stream delay</dt><dd className="num text-right">{s.bookDelayMs} ms</dd>
  </dl>;
}
/** The real-money switch. Turning it on takes two presses; turning it off takes one and works even if the bot is down. */
function RealSwitch({b,onChange}:{b:any;onChange:()=>void}){
  const [asking,setAsking]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const sw=b.switch,on=!!sw?.armed,running=!!b.status?.running,cash=b.missing?b.status?.budget:b.cash;
  const set=async(armed:boolean)=>{setBusy(true);setError('');
    try{const r=await fetch('/api/bot/live',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({armed})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error??`HTTP ${r.status}`);setAsking(false);onChange();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <Card className={cn('border',on?'border-no':'border-line')}>
    <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">Real trading</h2>{on?<Pill tone="no">On: placing real orders</Pill>:<Pill tone="neutral">Off</Pill>}</div>
    <p className="mt-2 max-w-4xl text-sm text-muted">{on
      ?`The bot is buying on your Kalshi account with real money, one order a round at most. It can spend only what is in its own record below (${dollars(cash)} now); the rest of your Kalshi balance is never counted.`
      :`While this is off the bot only watches and places no orders. When on, it buys on your Kalshi account with real money, from a budget of ${dollars(b.status?.budget??15)} that it tracks in its own record. In testing on paper this rule did not beat the fees.`}</p>
    {!on&&sw?.note?<p className="mt-2 max-w-4xl text-sm text-warn" role="status">Switched off{sw.by==='bot'?' by the bot':''}{sw.time?` at ${new Date(sw.time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:''}: {sw.note}</p>:null}
    {error?<p className="mt-2 text-sm text-no" role="alert">{error}</p>:null}
    <div className="mt-3 flex flex-wrap items-center gap-2">{on
      ?<Button variant="outline" onClick={()=>void set(false)} disabled={busy}>Turn off</Button>
      :asking
        ?<><Button className="bg-no text-bg hover:bg-no/85" onClick={()=>void set(true)} disabled={busy}>Yes, trade real money</Button><Button variant="ghost" onClick={()=>setAsking(false)} disabled={busy}>Cancel</Button></>
        :<Button variant="outline" onClick={()=>setAsking(true)} disabled={!running}>Turn on</Button>}
      {!on&&!running?<span className="text-sm text-muted">The bot is not running, so there is nothing to turn on.</span>:null}
      {on?<span className="text-sm text-muted">Turning off stops new orders. A round already bought is held to settlement.</span>:null}</div>
  </Card>;
}
export default function Bot(){
  const [b,setB]=useState<any>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const load=useCallback(async()=>{setLoading(true);try{const r=await fetch('/api/bot',{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);setB(await r.json());setError('');}catch(e){setError((e as Error).message);}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();const t=setInterval(()=>void load(),REFRESH_MS);return()=>clearInterval(t);},[load]);
  const s=b?.status,c=s?.config,target=c?.target??100,ci=b?.perContractCi,live=!!b?.live;
  const progress=b&&!b.missing?(target>b.start?Math.max(0,Math.min(1,(b.equity-b.start)/(target-b.start))):0):0;
  return <>
    <SiteHeader current="/bot"><Button variant="ghost" size="sm" onClick={()=>void load()} disabled={loading} aria-label="Refresh bot record"><RefreshCw aria-hidden className={cn('size-4',loading&&'animate-spin')}/>{b?new Date(b.updated).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'—'}</Button></SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      <Card className="rise"><div className="flex flex-wrap items-center gap-3"><h1 className="font-display text-4xl font-bold">Trading bot</h1>{live?<Pill tone="no">Real money</Pill>:<Pill tone="warn">Paper money</Pill>}{s?.running?(s.connected?<Pill tone="yes">Running</Pill>:<Pill tone="warn">Reconnecting</Pill>):<Pill tone="no">Not running</Pill>}{error?<Pill tone="no">{error}</Pill>:null}</div>
        <p className="mt-2 max-w-4xl text-sm text-muted">{live
          ?'A program trading the 15-minute BTC market on your Kalshi account, with real money, while the switch below is on. It buys one side a round when its model beats the ask after the fee, and holds to settlement.'
          :'A program trading the 15-minute BTC market on paper against the live Kalshi book. It places no real orders. It buys one side a round when its model beats the ask after the fee, and holds to settlement.'} Judge it by the result per contract once {JUDGE_AT} rounds have settled; the bankroll before then is mostly luck.</p></Card>
      {b&&live?<RealSwitch b={b} onChange={()=>void load()}/>:null}
      {!b?<Empty>{error?`Could not load the bot record: ${error}`:'Loading the bot record…'}</Empty>:b.missing?<Empty>{live?'No real-money record yet. The bot creates it the first time it runs.':'No paper account yet. The bot creates it the first time it runs.'}</Empty>:<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Bankroll" className={tone(b.equity-b.start)} sub={`started with ${dollars(b.start)} · peak ${dollars(b.peak)}`}>{dollars(b.equity)}</Kpi>
        <Kpi label={`Progress to ${dollars(target,0)}`} sub={<span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Progress to ${dollars(target,0)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress*100)}><span className="block h-full rounded-full bg-yes" style={{width:`${progress*100}%`}}/></span>}>{pct(progress,0)}</Kpi>
        <Kpi label="Result per contract" className={tone(b.perContract)} sub={ci!=null?`95% range ${signedCents(b.perContract-ci)} to ${signedCents(b.perContract+ci)}`:'needs 2 settled rounds'}>{signedCents(b.perContract)}</Kpi>
        <Kpi label="Rounds settled" sub={`${b.wins} won · ${b.open} open · verdict at ${JUDGE_AT}`}>{b.rounds}</Kpi>
        <Kpi label="Total result" className={tone(b.pnl)} sub={`after ${dollars(b.fees)} in fees`}>{signedDollars(b.pnl)}</Kpi>
        <Kpi label="Missed orders" sub={live?'price moved, nothing bought':'ask moved before the fill'}>{b.misses}</Kpi>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><h2 className="mb-3 font-semibold">Right now</h2><Now s={s} off={live&&!b.switch?.armed}/></Card>
        <Card><h2 className="mb-4 font-semibold">Cumulative result</h2>{b.curve.length?<Equity data={b.curve}/>:<Empty>No settled rounds yet.</Empty>}</Card>
      </div>
      {c?<Card><h2 className="mb-3 font-semibold">Its rules</h2><dl className="grid grid-cols-2 gap-y-2 text-sm md:grid-cols-4">
        <dt className="text-muted">Edge needed after fee</dt><dd className="num text-right md:pr-6">{cents(c.minEdge,0)}</dd>
        <dt className="text-muted">Prices it buys</dt><dd className="num text-right md:pr-6">{c.midBand?`${cents(c.minAsk,0)}–${cents(c.midBand[0],0)}, ${cents(c.midBand[1],0)}–${cents(c.maxAsk,0)}`:`${cents(c.minAsk,0)}–${cents(c.maxAsk,0)}`}</dd>
        <dt className="text-muted">Time left when it buys</dt><dd className="num text-right md:pr-6">{mmss(c.window[1])}–{mmss(c.window[0])}</dd>
        <dt className="text-muted">Most it risks a round</dt><dd className="num text-right md:pr-6">{pct(c.maxRisk,0)} of bankroll</dd>
        <dt className="text-muted">{live?'Order type':'Fill delay simulated'}</dt><dd className="num text-right md:pr-6">{live?'fill now or cancel':`${c.latencyMs} ms`}</dd>
        {c.exit?<><dt className="text-muted">Sells early when</dt><dd className="text-right md:pr-6 md:col-span-3">{[c.exit.below?`the price halves from its entry`:'',c.exit.back?`it was up ${cents(c.exit.up,0)} or more and falls back to ${pct(c.exit.back,0)} of its high`:''].filter(Boolean).join(', or ')||'never'}</dd></>:null}
        <dt className="text-muted">Average entry price</dt><dd className="num text-right md:pr-6">{cents(b.avgPrice)}</dd>
        <dt className="text-muted">Average edge it saw</dt><dd className="num text-right md:pr-6">{signedCents(b.avgEdge)}</dd>
        <dt className="text-muted">Contracts settled</dt><dd className="num text-right md:pr-6">{qty(b.contracts)}</dd>
      </dl></Card>:null}
      <Card><h2 className="mb-3 font-semibold">Trade history</h2>{b.trades.length?<div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['When','Market','Side','Contracts','Price','Model said','Edge seen','Time left','Fees','Result'].map(h=><th key={h} scope="col" className="pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{b.trades.map((m:any,i:number)=><tr key={`${m.ticker}-${m.time}-${i}`} className="border-t border-line"><td className="py-2 pr-3 text-muted">{new Date(m.time).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</td><td className="num pr-3 text-xs">{m.ticker.replace('KXBTC15M-','')}</td>
          <td className={cn('pr-3 font-medium',m.side==='yes'?'text-yes':'text-no')}>{m.side.toUpperCase()}</td><td className="num pr-3">{qty(m.contracts)}</td><td className="num pr-3">{cents(m.price)}</td><td className="num pr-3">{pct(m.q)}</td><td className="num pr-3">{signedCents(m.edge)}</td><td className="num pr-3">{m.secsLeft!=null?mmss(m.secsLeft):'—'}</td><td className="num pr-3 text-muted">{dollars(m.fee)}</td>
          <td className={cn('num',tone(m.pnl))}>{m.pnl==null?<span className="text-muted">open</span>:<>{signedDollars(m.pnl)}{m.result==='sold'?<span className="ml-1 text-xs text-muted">sold</span>:null}</>}</td></tr>)}</tbody></table></div>:<Empty>{live?'No real trades yet.':'No paper trades yet.'}</Empty>}</Card>
      </>}
    </main>
  </>;
}
