'use client';
import {TriangleAlert} from 'lucide-react';
import {Pill} from './panels';
import {cents,signedCents,signedDollars,pct,mmss,ago} from './format';
import {cn} from '@/lib/utils';
/**
 * Edge layer (edge/ sidecar, DECISIONS 75): settlement-aware fair value, fee-aware gate and risk governor, advisory
 * only. The directional call shown here is the engine's own live call, unchanged; the gate prices with p_base unless
 * ENGINE_VALIDATED is set.
 */
type Tone='yes'|'no'|'warn'|'neutral';
function badge(e:any):{tone:Tone;text:string}{
  if(!e||e.status==='OFFLINE')return {tone:'warn',text:'EDGE OFFLINE'};
  if(e.status==='IDLE')return {tone:'neutral',text:'Between windows'};
  if(e.action==='TRADE')return {tone:e.side==='no'?'no':'yes',text:`TRADE ${String(e.side).toUpperCase()} ×${e.contracts} @ ${cents(e.ask)} (edge ${signedCents(e.edge)})`};
  if(e.action==='BLOCKED')return {tone:'warn',text:`BLOCKED: ${e.reason}`};
  if(e.action==='MODEL_DISAGREE')return {tone:'warn',text:`MODEL DISAGREE: ${String(e.reason).split('; gate:')[0]}`};
  return {tone:'neutral',text:'NO EDGE'};
}
const Row=({label,children,title}:{label:string;children:React.ReactNode;title?:string})=><div className="flex items-baseline justify-between gap-3 py-1" title={title}><span className="text-sm text-muted">{label}</span><span className="num text-right">{children}</span></div>;

/** Shown above the instruments when the edge layer is offline, on its fallback price, or failing the settlement check. */
export function EdgeBanner({s,fresh}:{s:any;fresh:boolean}){
  const e=s?.edge;if(!fresh||!e||!s?.market)return null;
  const issues=[e.status==='OFFLINE'?`Edge layer offline${e.error?` (${e.error})`:''} — real KXBTC15M orders blocked`:null,
    e.status!=='OFFLINE'&&e.degraded?`Edge price degraded: ${e.carried?'carried forward (missed second)':'BRTI unavailable, using the exchange median'}`:null,
    e.proxy_check?.failing?`Settlement check failing: only ${pct(e.proxy_check.agree)} of the last ${e.proxy_check.windows} windows agree with Kalshi`:null].filter(Boolean);
  if(!issues.length)return null;
  return <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-warn/50 bg-warn-dim/40 px-4 py-2 text-sm text-warn">
    <TriangleAlert aria-hidden className="size-4 shrink-0"/>{issues.join(' · ')}</div>;
}

export function EdgePanel({s,fresh}:{s:any;fresh:boolean}){
  const e=s?.edge,call=s?.liveCall,b=badge(fresh?e:null),live=fresh&&e&&e.status!=='OFFLINE'&&e.ticker===s?.market?.ticker;
  const r=e?.risk,mid=s?.quant?.mid??e?.market_mid;
  return <div className="space-y-4 px-5 pb-5">
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn('inline-flex min-h-9 items-center rounded-lg px-3 text-sm font-semibold',{yes:'bg-yes-dim text-yes',no:'bg-no-dim text-no',warn:'bg-warn-dim text-warn',neutral:'bg-surface-2 text-muted'}[b.tone])}>{b.text}</span>
      <Pill tone="neutral" title="Mode and which probability the gate uses">{e?.config?.mode??'shadow'} · {e?.p_used==='engine'?'p_engine':'p_base'}</Pill>
    </div>
    <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
      <div>
        <div className="label pb-1">Directional call</div>
        <Row label="Engine call">{call?.direction?<span className={call.direction==='UP'?'text-yes':'text-no'}>{call.direction} · {call.confidence} ({pct(call.p)})</span>:'—'}</Row>
        <Row label="Fair value p_yes (base)" title="Settlement-aware, zero drift">{live?pct(e.p_base):'—'}</Row>
        {live&&e.p_engine!=null&&Math.abs(e.p_engine-(e.p_base??0))>=.0005?<Row label="Fair value (engine drift)" title="Built from q_raw: the stack before Kalshi's mid">{pct(e.p_engine)}</Row>:null}
        <Row label="Market mid">{pct(mid)}</Row>
        <Row label="YES / NO ask">{cents(live?e.yes_ask:null)} / {cents(live?e.no_ask:null)}</Row>
      </div>
      <div>
        <div className="label pb-1">Window</div>
        <Row label="Regime">{live?(e.regime==='final_minute'?'Final minute':e.regime==='pre_window'?'Before final minute':e.status.toLowerCase()):'—'}</Row>
        <Row label="Seconds left">{live?mmss(e.secs_left):'—'}</Row>
        {live&&e.regime==='final_minute'?<Row label="Running 60 s average" title={`${e.final_n} of 60 prints`}>{e.final_avg!=null?`$${e.final_avg.toFixed(2)}`:'—'} <span className="text-muted">vs ${e.target?.toFixed(2)}</span></Row>:null}
        <Row label="σ (annualised)">{live?pct(e.sigma_ann,0):'—'}</Row>
        <Row label="Price source">{live?<span className={e.degraded?'text-warn':''}>{e.source==='brti'?'BRTI (Kalshi)':'Exchange median'}{e.carried?' · carried':''}</span>:'—'}</Row>
      </div>
    </div>
    <div>
      <div className="label pb-1">Risk ({r?.book==='real'?'real fills':'paper book'})</div>
      <Row label="Today's P&L vs daily stop">{r?<>{signedDollars(r.day_pnl)} <span className="text-muted">/ {signedDollars(r.daily_stop_usd)}</span></>:'—'}</Row>
      <Row label="Windows used">{r?`${r.windows_used} / ${r.max_windows}`:'—'}</Row>
      <Row label="Governor">{r?<span className={r.allowed?'text-muted':'text-warn'}>{r.allowed?'allows':r.reason}</span>:'—'}</Row>
      <Row label="Real orders on this market">{e?.real_risk?<span className={e.real_risk.allowed&&e.gate?.action==='TRADE'?'text-yes':'text-muted'}>{e.status==='OFFLINE'?'blocked (offline)':e.gate?.action!=='TRADE'?'blocked (no gate TRADE)':e.real_risk.allowed?`allowed: ${String(e.gate.side).toUpperCase()} only`:`blocked: ${e.real_risk.reason}`}</span>:'—'}</Row>
    </div>
    <p className="text-xs text-faint">Advisory and logging only · data/edge.db · reply {e?.ageMs!=null?ago(e.ageMs):'—'} old{e?.proxy_check?.windows?` · settlement check ${pct(e.proxy_check.agree)} of ${e.proxy_check.windows}`:''}</p>
  </div>;
}
