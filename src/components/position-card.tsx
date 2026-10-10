'use client';
import {useState} from 'react';
import {Pill,Stat,Notice,toneText,type Tone} from './panels';
import {Button} from './ui/button';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,cents,pct,qty,ago} from './format';
const SOURCE:Record<string,string>={polymarket:'Polymarket',sportsbooks:'Sportsbooks'};
const ext={target:'_blank',rel:'noreferrer',className:'text-info hover:underline'};
/**
 * The outside price next to Kalshi's. A trusted one (auto match or confirmed) shows its basis; a suggestion asks you to
 * confirm it is the same market. Your answer is saved by the markets process and applies from the next update.
 */
function ReferenceLine({c,now}:{c:any;now:number}){
  const r=c.reference,[busy,setBusy]=useState(false),[error,setError]=useState('');if(!r)return null;
  const p=c.side==='yes'?r.prob:1-r.prob,name=SOURCE[r.source]??r.source,gap=c.marketProb!=null?(p-c.marketProb)*100:null;
  const decide=async(status:'confirmed'|'rejected')=>{setBusy(true);setError('');try{const res=await fetch('/api/markets/match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker:c.ticker,source:r.source,refId:r.refId,status})});if(!res.ok)throw new Error(`Could not save (HTTP ${res.status})`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  if(r.status==='suggested')return <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted"><span>Possible match on {name}: <a href={r.url} {...ext}>“{r.title}”</a> (<span className="num">{pct(p,1)}</span>)</span>
    <Button size="sm" variant="outline" disabled={busy} onClick={()=>void decide('confirmed')} aria-label={`Confirm “${r.title}” is the same market`}>✓ Same market</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void decide('rejected')} aria-label={`“${r.title}” is not the same market`}>✗ Not it</Button>{error?<span className="text-xs text-warn">{error}</span>:null}</div>;
  return <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">{r.url?<a href={r.url} {...ext}>{name}</a>:<span>{name}</span>} <span className="num">{pct(p,1)}</span><span className="text-muted">· Kalshi <span className="num">{pct(c.marketProb,1)}</span>{gap!=null?<> · gap <span className="num">{gap>=0?'+':'−'}{Math.abs(gap).toFixed(1)} pts</span></>:null} · {ago(Math.max(0,now-r.time))} ago</span>
    <Pill tone="neutral">{r.status==='confirmed'?'you confirmed':'auto match'}</Pill>{r.stale?<span className="text-warn">stale</span>:null}</div>;
}
const groupLabel:Record<string,string>={sports:'Sports',combos:'Combo',politics:'Politics & econ',commodities:'Commodities & crypto'};
/** Cents with two decimals below 1¢, where combos trade. */
const price=(v:number|null|undefined)=>v!=null&&v<.01?cents(v,2):cents(v);
const sp=(x:number|null|undefined)=>x==null?'—':`${x>=0?'+':'−'}${Math.abs(x*100).toFixed(0)}%`;
function until(t:number|null,now:number){
  if(!t)return null;const s=Math.round((t-now)/1000);if(s<=0)return 'result due';
  const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return `result in ${d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${m}m`}`;
}
/** The YES price (for a combo, its value at leg odds) since you entered, from the 30-s snapshots. */
function Spark({points,label}:{points:{t:number;mid:number}[];label:string}){
  if(points.length<2)return <div className="text-xs text-faint">Price line builds every 30 s.</div>;
  const t0=points[0].t,t1=points.at(-1)!.t,lo=Math.min(...points.map(p=>p.mid)),hi=Math.max(...points.map(p=>p.mid)),w=160,h=40;
  const d=points.map((p,k)=>`${k?'L':'M'}${((p.t-t0)/Math.max(1,t1-t0)*w).toFixed(1)},${(h-(p.mid-lo)/Math.max(1e-9,hi-lo)*h).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-40" role="img" aria-label={`${label} from ${price(points[0].mid)} to ${price(points.at(-1)!.mid)}`}><path d={d} fill="none" stroke="var(--color-info)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/></svg>;
}
/** One open position: the hold-or-sell verdict and P&L, cost, any heads-up, the reasoning, combo legs, and the sell/hold numbers. */
export function PositionCardView({c,now}:{c:any;now:number}){
  const pnlTone:Tone=c.unrealized>.005?'yes':c.unrealized<-.005?'no':'neutral';
  // A combo's bid sits on an almost empty book (often 0.1¢), so P&L at the bid says little about where it stands; the
  // headline compares its value at leg odds with what it cost. P&L if sold stays in the numbers on the right.
  const cost=c.avgCost!=null?c.contracts*c.avgCost:null,atLegs=c.probSource==='legs'&&c.holdValue!=null&&cost?c.holdValue-cost:null;
  const head=atLegs??c.unrealized,headPct=atLegs!=null&&cost?atLegs/cost:c.unrealizedPct,headTone:Tone=head>.005?'yes':head<-.005?'no':'neutral';
  const verdictTone:Tone=c.verdict==='DEAD'?'no':c.verdict==='SELL BEATS HOLD'?'warn':c.verdict==='HOLD'?headTone:'neutral';
  const due=until(c.expectedExpiration??c.closeTime,now);
  return <div className="grid gap-4 border-t border-line pt-4 first:border-0 first:pt-0 lg:grid-cols-[1fr_auto]">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-sm"><Pill tone="neutral">{groupLabel[c.group]??c.group}</Pill><span className="font-medium">{c.title}</span><span className="min-w-0 truncate text-muted">{c.marketTitle}</span></div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1"><div className={cn('font-display text-5xl leading-none font-bold uppercase',toneText[verdictTone],c.stale&&'opacity-60')}>{c.verdict}</div>
        {head!=null&&!['SETTLING','DEAD'].includes(c.verdict)?<div className={cn('num text-2xl font-semibold',toneText[headTone])}>{head>=0?'UP':'DOWN'} {signedDollars(head)} <span className="text-base">({sp(headPct)})</span>{atLegs!=null?<span className="ml-1.5 font-sans text-sm font-normal text-muted">at leg odds</span>:null}</div>:null}</div>
      <div className="mt-2 text-sm"><span className="num">{qty(c.contracts)}</span> {c.side.toUpperCase()} · cost <span className="num">{price(c.avgCost)}</span> incl. fees{c.costSource==='estimate'?<span className="text-faint"> (estimated)</span>:null} · win chance <span className="num">{pct(c.winProb,c.winProb!=null&&c.winProb<.01?2:0)}</span>{due?<> · {due}</>:null}{c.stale?<span className="text-warn"> · prices stale</span>:null}</div>
      {c.combo?null:<ReferenceLine c={c} now={now}/>}
      {c.peakPct!=null&&(c.probSource==='market'||c.probSource==='reference')?<div className="mt-1 text-xs text-muted">Best {sp(c.peakPct)} · worst {sp(c.troughPct)} so far</div>:null}
      {c.notice?<Notice notice={c.notice}/>:null}
      <p className="mt-2 text-sm text-fg/90">{c.reason}</p>
      {c.combo?<div className="mt-3 overflow-x-auto"><table className="w-full min-w-[480px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Leg','Side','Status','Bid / ask','Kalshi','Outside'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
        <tbody>{c.combo.legs.map((l:any)=><tr key={l.ticker} className="border-t border-line"><th scope="row" className="py-1.5 pr-3 text-left font-medium">{l.label}</th><td className="pr-3 text-muted">{l.side.toUpperCase()}</td>
          <td className="pr-3">{l.status==='won'?<Pill tone="yes">won</Pill>:l.status==='lost'?<Pill tone="no">lost</Pill>:l.status==='unknown'?<Pill tone="warn">no price</Pill>:<span className="text-muted">to play</span>}</td>
          <td className="num pr-3">{l.status==='pending'?`${price(l.bid)} / ${price(l.ask)}`:'—'}</td><td className="num pr-3">{pct(l.p,0)}</td><td className="num">{l.ref!=null?<>{pct(l.ref,0)} <span className="text-xs text-faint" title={SOURCE[l.refSource]}>{l.refSource==='sportsbooks'?'S':'P'}</span></>:'—'}</td></tr>)}</tbody></table>
        <p className="mt-2 text-xs text-faint">{c.combo.won} won · {c.combo.pending} to play{c.combo.correlated?' · some legs are on the same game, so the value is rough':''}. Value = each leg&apos;s chance multiplied (independent legs){c.combo.refLegs?<>; {c.combo.refLegs} of {c.combo.pending} open legs at outside odds (P = Polymarket, S = sportsbooks): <span className="num">{price(c.combo.refValue)}</span> vs <span className="num">{price(c.combo.value)}</span> at Kalshi&apos;s</>:null}.</p></div>:null}
    </div>
    <div className="flex flex-col items-end gap-3 self-start"><div className="grid grid-cols-3 gap-5 text-right">
      <Stat label="P&L if sold" tone={pnlTone} sub={c.unrealizedPct!=null?`${sp(c.unrealizedPct)} of cost`:undefined}>{signedDollars(c.unrealized)}</Stat>
      <Stat label="Sell now" sub={c.bid!=null?`bid ${price(c.bid)} − ${dollars(c.sellFee)} fee`:'no bid'}>{dollars(c.sellValue)}</Stat>
      <Stat label="Hold value" sub={c.probSource==='legs'?(c.combo?.refLegs?'outside legs × $1':'legs × $1'):c.probSource==='settled'?'payout':c.probSource==='reference'?<>outside odds × $1 · Kalshi {dollars(c.contracts*(c.marketProb??0))}</>:'market odds × $1'}>{dollars(c.holdValue)}</Stat></div>
      <Spark points={c.spark??[]} label={c.combo?'Value at leg odds':'YES price'}/></div>
  </div>;
}
