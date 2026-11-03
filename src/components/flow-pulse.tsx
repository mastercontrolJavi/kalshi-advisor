'use client';
import {useState} from 'react';
import {ArrowUpRight,ArrowDownRight,Minus} from 'lucide-react';
import {flowAlignment,FLOW_RATIO_VOTE,FLOW_IMPULSE_Z,FLOW_IMPULSE_MIN_USD,type FlowVerdict} from '@/engine/flow';
import {Pill,type Tone} from './panels';
import {SectionHelp} from './section-help';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,pct,ago} from './format';

const verdictTone:Record<FlowVerdict,Tone>={confirmed:'yes',fighting:'no',mixed:'neutral',unknown:'neutral'};
const btc=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?'—':`${v>0?'+':v<0?'−':''}${Math.abs(v).toFixed(Math.abs(v)>=10?1:2)}`;
const vote=(v:number|null)=>v===1?'↑':v===-1?'↓':v===0?'–':'?';
const Dir=({d,className}:{d:number|null|undefined;className?:string})=>d===1?<ArrowUpRight aria-hidden className={className}/>:d===-1?<ArrowDownRight aria-hidden className={className}/>:<Minus aria-hidden className={className}/>;

/** Verdict for one direction, with the three votes behind it. */
function Alignment({label,direction,p}:{label:string;direction:string|null|undefined;p:any}){
  if(!direction)return <li className="flex items-center justify-between gap-3 border-t border-line py-1.5 text-sm first:border-0"><span className="font-medium">{label}</span><span className="text-xs text-muted">no call this round yet</span></li>;
  const a=flowAlignment(direction,p);
  return <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line py-1.5 first:border-0">
    <span className="text-sm"><span className="font-medium">{label}</span>{direction?<span className="num ml-1.5 text-muted">{String(direction).toUpperCase()}</span>:null}</span>
    <span className="flex items-center gap-2"><span className="num text-xs text-muted" title="Votes: Coinbase spot flow · perp flow · perp impulse">spot {vote(a.votes.spot)} · perp {vote(a.votes.perp)} · impulse {vote(a.votes.impulse)}</span><Pill tone={verdictTone[a.verdict]}>{a.label}</Pill></span></li>;
}

/**
 * Order flow & futures pulse (engine flow.ts / flow-worker.ts, DECISIONS 71): taker flow on Coinbase spot and the
 * Binance / Bybit perps, the perp's lead over spot and the basis, plus whether that flow backs the calls, your positions
 * or an idea you pick. Untested against Kalshi: shown for manual trading while the 250 ms bars are collected for quant/.
 */
export function FlowPulse({s,fresh}:{s:any;fresh:boolean}){
  const p=s?.flowPulse,[idea,setIdea]=useState<'UP'|'DOWN'|null>(null);
  if(!p)return <p className="text-sm text-muted">Off (FLOW_PULSE=off).</p>;
  if(p.starting)return <p className="text-sm text-muted">Connecting to Coinbase, Binance and Bybit…</p>;
  const stale=!fresh||p.ageMs>1500,live=fresh&&!stale?p:null,l=p.lead,b=p.basis;
  const ideaButton=(d:'UP'|'DOWN')=><button type="button" onClick={()=>setIdea(idea===d?null:d)} aria-pressed={idea===d} className={cn('rounded-lg border px-2 py-0.5 text-xs font-medium',idea===d?(d==='UP'?'border-yes/60 bg-yes-dim/40 text-yes':'border-no/60 bg-no-dim/40 text-no'):'border-line text-muted hover:text-fg')}>{d}</button>;
  const positions=(s?.exits??[]).filter((e:any)=>e.side==='yes'||e.side==='no');
  const leadTone=l.impulse===1?'text-yes':l.impulse===-1?'text-no':'text-fg';
  // Three columns when the panel is wide (full row up to 1920 px), stacked in the narrow right column above that.
  return <div className="@container"><div className={cn('grid gap-4 @4xl:grid-cols-3 @4xl:gap-6',stale&&'opacity-60')}>
    {stale?<p role="status" className="text-xs text-warn @4xl:col-span-3">Pulse {fresh?`${ago(p.ageMs)} old`:'stale'} — not current.</p>:null}
    <div><div className="flex items-center gap-1"><span className="label">Flow alignment</span><SectionHelp title="Flow alignment"/></div>
      <ul className="mt-1">
        <Alignment label="Live call" direction={s?.liveCall?.direction} p={live}/>
        <Alignment label="Opening call" direction={s?.openingCall?.direction} p={live}/>
        {positions.map((e:any)=><Alignment key={e.ticker} label={`Your ${e.side.toUpperCase()} position`} direction={e.side==='yes'?'UP':'DOWN'} p={live}/>)}
        <li className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-1.5"><span className="flex items-center gap-2 text-sm font-medium">Your idea {ideaButton('UP')}{ideaButton('DOWN')}</span>{idea?<Pill tone={verdictTone[flowAlignment(idea,live).verdict]}>{flowAlignment(idea,live).label}</Pill>:<span className="text-xs text-muted">pick a side to check it</span>}</li>
      </ul></div>
    <div className="grid content-start gap-4 @md:grid-cols-2 @4xl:grid-cols-1">
      <div><div className="flex items-center gap-1"><span className="label">Futures lead</span><SectionHelp title="Futures lead"/></div>
        <div className={cn('num mt-1.5 flex items-center gap-1 text-xl font-medium',leadTone)}><Dir d={l.impulse} className="size-5"/>{l.impulse===1?'Perp leading UP':l.impulse===-1?'Perp leading DOWN':'No impulse'}</div>
        <div className="num mt-0.5 text-xs text-muted">1 s: perp {signedDollars(l.perp1s)} · spot {signedDollars(l.spot1s)} · lead {signedDollars(l.lead1s)}{l.z!=null?` (${l.z.toFixed(1)} sd)`:''}</div>
        <div className="num text-xs text-muted">5 s: perp {signedDollars(l.perp5s)} · spot {signedDollars(l.spot5s)} · lead {signedDollars(l.lead5s)}</div></div>
      <div><div className="flex items-center gap-1"><span className="label">Basis</span><SectionHelp title="Perp basis"/></div>
        <div className={cn('num mt-1.5 text-xl font-medium',b.change==null?'text-fg':b.change>0?'text-yes':b.change<0?'text-no':'text-fg')}>{signedDollars(b.change)} <span className="font-sans text-sm font-normal text-muted">vs 5-min avg</span></div>
        <div className="num mt-0.5 text-xs text-muted">Perp {dollars(p.perp)} − Coinbase {dollars(p.spot)} = {signedDollars(b.usd)}</div>
        {p.mark?<div className="num text-xs text-muted">Premium to Binance index {p.mark.premiumBps>=0?'+':'−'}{Math.abs(p.mark.premiumBps).toFixed(1)} bps · funding {pct(p.mark.funding,3)}</div>:null}</div>
    </div>
    <div><div className="flex items-center gap-1"><span className="label">Aggressive flow (CVD)</span><SectionHelp title="Aggressive flow"/></div>
      <table className="num mt-1 w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th className="py-1 font-normal">Taker BTC</th><th className="py-1 text-right font-normal">15 s</th><th className="py-1 text-right font-normal">60 s</th><th className="py-1 text-right font-normal">60 s buys</th></tr></thead>
        <tbody>{p.venues.map((v:any)=>{const w15=v.windows.find((w:any)=>w.seconds===15),w60=v.windows.find((w:any)=>w.seconds===60);
          return <tr key={v.id} className="border-t border-line"><td className="py-1 font-sans"><span className={cn('mr-1.5 inline-block size-2 rounded-full',v.healthy?'bg-yes':'bg-warn')}/>{v.label}</td>
            <td className={cn('py-1 text-right',w15?.cvd>0?'text-yes':w15?.cvd<0?'text-no':'')}>{btc(w15?.cvd)}</td><td className={cn('py-1 text-right',w60?.cvd>0?'text-yes':w60?.cvd<0?'text-no':'')}>{btc(w60?.cvd)}</td><td className="py-1 text-right">{pct(w60?.ratio,0)}</td></tr>;})}
          {(['spot','perp'] as const).map(k=>{const f=p.flow[k];return <tr key={k} className="border-t border-line text-xs text-muted"><td className="py-1 font-sans">{k==='spot'?'Spot vote':'Perps combined'}</td><td/><td className="py-1 text-right">{btc(f.cvd)}</td><td className="py-1 text-right">{pct(f.ratio,0)} <span className="ml-1">{vote(f.vote)}</span></td></tr>;})}
        </tbody></table></div>
    <p className="text-xs text-faint @4xl:col-span-3">Untested rule: a side votes at ≥ {Math.round(FLOW_RATIO_VOTE*100)}% taker buys (≤ {Math.round((1-FLOW_RATIO_VOTE)*100)}% for down) over 60 s; an impulse is a 1 s perp lead ≥ {FLOW_IMPULSE_Z} sd and ≥ ${FLOW_IMPULSE_MIN_USD}. Recording 250 ms bars for the Python study{p.db?<> · <span className="num">{p.db.written.toLocaleString()}</span> this session{p.db.error?<span className="text-warn"> · write error: {p.db.error}</span>:null}</>:null}. Feed delay {p.venues.map((v:any)=>`${v.label.split(' ')[0]} ${v.delayMs} ms`).join(' · ')}.</p>
  </div></div>;
}
