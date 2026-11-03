'use client';
import {useRef} from 'react';
import {FlaskConical} from 'lucide-react';
import {masterSignal,type MasterKind} from '@/engine/master-signal';
import {baseFees} from '@/engine/model/fees';
import {Card} from './ui/card';
import {Pill} from './panels';
import {useFlash} from './motion';
import {cn} from '@/lib/utils';
import {cents,dollars,signedDollars} from './format';

const look:Record<MasterKind,{dot:string;text:string;border:string;bg:string}>={
  buy:{dot:'🟢',text:'text-yes',border:'border-yes',bg:'bg-yes-dim/50'},
  wait:{dot:'🟡',text:'text-warn',border:'border-warn/60',bg:'bg-warn-dim/30'},
  hold:{dot:'🔵',text:'text-info',border:'border-info/70',bg:'bg-info/10'},
  exit:{dot:'🟠',text:'text-no',border:'border-no',bg:'bg-no-dim/50'},
  paused:{dot:'⏸',text:'text-muted',border:'border-line-strong',bg:'bg-surface-2/50'}};
const feeText=(f:number)=>f<.00005?'$0 fee':`Fee: ${cents(f,2)}`;

/** The Master Signal card (master-signal.ts): one action at the top of the dashboard, computed in the browser. */
export function MasterSignal({s,fresh}:{s:any;fresh:boolean}){
  // The perp impulse fires for about a second; remember when it last fired (engine clock) so it counts for 5 s.
  const last=useRef<{dir:1|-1;at:number}|null>(null),now=s?.engineTime??0,imp=s?.flowPulse?.lead?.impulse;
  if((imp===1||imp===-1)&&s?.flowPulse?.healthy)last.current={dir:imp,at:now};
  const pos=(s?.exits??[]).find((e:any)=>e.ticker===s?.market?.ticker)??null;
  const m=masterSignal({fresh:fresh&&!!s?.market,stale:!!s?.breaker?.stale,staleReasons:s?.breaker?.reasons,entriesClosed:(s?.tau??Infinity)<(s?.config?.finalMinuteSignals?5:60),
    liveCall:s?.liveCall,openingCall:s?.openingCall,pulse:s?.flowPulse,impulse:last.current?{dir:last.current.dir,ageMs:now-last.current.at}:null,
    danger:s?.danger,book:s?.book,schedule:{...baseFees,...s?.kalshi?.fees,precision:s?.config?.feePrecision??baseFees.precision},position:pos});
  const t=look[m.kind],flash=useFlash<HTMLDivElement>(m.title);
  return <Card className={cn('rise border-2 p-4 sm:p-5',t.border,t.bg)} aria-label="Master signal">
    <div className="flex flex-wrap items-center gap-2"><h2 className="label">Master signal</h2>
      <Pill tone="neutral" title="Combines the live and opening calls (neither beats Kalshi's price in the backtest) with the order-flow badge (no out-of-sample result yet). Not an edge until quant/ research.py flow says so."><FlaskConical aria-hidden className="size-3.5"/>untested rule</Pill>
      {m.side?<span className="ml-auto text-xs text-muted">{pos?`your ${m.side.toUpperCase()} position`:`side ${m.side.toUpperCase()}`}</span>:null}</div>
    <div ref={flash} aria-live="polite" className={cn('font-display mt-2 origin-left text-4xl leading-none font-bold tracking-tight uppercase sm:text-6xl',t.text)}><span aria-hidden className="mr-2">{t.dot}</span>{m.title}</div>
    {m.entry?<div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div className="rounded-xl border border-line bg-surface/60 px-3 py-2"><div className="label">Maker Limit Entry</div><div className="num text-2xl font-semibold">{cents(m.entry.maker.price,0)} <span className="text-base font-normal text-muted">({feeText(m.entry.maker.fee)})</span></div><div className="text-xs text-muted">Rest a buy; fills only if a seller hits it</div></div>
      <div className="rounded-xl border border-line bg-surface/60 px-3 py-2"><div className="label">Taker Entry</div><div className="num text-2xl font-semibold">{cents(m.entry.taker.price,0)} <span className="text-base font-normal text-warn">(Fee: {cents(m.entry.taker.fee,2)})</span></div><div className="text-xs text-muted">Buy the ask now · fee per contract</div></div></div>:null}
    {m.exit?<div className="mt-3 rounded-xl border border-line bg-surface/60 px-3 py-2"><div className="label">B · Maker sell at the ask</div><div className="num text-2xl font-semibold">{cents(m.exit.price,0)} <span className="text-base font-normal text-muted">({feeText(m.exit.fee)}{m.exit.fee>=.00005?` · ${dollars(m.exit.fee)}`:''})</span></div><div className="text-xs text-muted">Net of your cost {signedDollars(m.exit.net)} · fills only if a buyer lifts it</div></div>:null}
    <ul className="mt-3 space-y-0.5 text-sm text-fg/90">{m.reasons.map(r=><li key={r}>{r}</li>)}</ul>
    {m.advice&&m.advice!=='HOLD'&&m.advice!=='LET IT SETTLE'?<p className="mt-1 text-xs text-muted">Your positions panel says <span className="font-medium text-fg">{m.advice}</span> (the exit rules in Settings); this card uses only A/B and the flow.</p>:null}
  </Card>;
}
