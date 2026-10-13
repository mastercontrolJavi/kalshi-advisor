'use client';
import {ChevronRight,ScanLine} from 'lucide-react';
import {SectionHelp} from './section-help';
import {cn} from '@/lib/utils';
import {dollars,pct} from './format';
import {PRICE_HORIZONS,type PricePrediction,type PriceScore} from '@/engine/quant/price-forecast';

export const horizonLabel=(h:number)=>h===30?'30s':h===60?'1m':'3m';
type Board={ready:boolean;reason:string|null;horizons:PricePrediction[];scores:Record<number,PriceScore&{flat:number;missing:number;pending:number}>;fitting:boolean};
export default function ShortTermForecast({board,fresh,horizon,onSelect,bitcoin}:{board:Board|null;fresh:boolean;horizon:number;onSelect:(h:number)=>void;bitcoin:boolean}){
  const predictions=board?.horizons??[],selected=predictions.find(p=>p.horizon===horizon),ready=fresh&&board?.ready,total=PRICE_HORIZONS.reduce((n,h)=>n+(board?.scores?.[h]?.n??0),0);
  return <section aria-label="Short-term Bitcoin forecast" className="mt-3 border-t border-line pt-3">
    <div className="mb-2 flex flex-wrap items-center gap-1.5"><ScanLine aria-hidden className="size-3.5 text-info"/><h3 className="label">BTC · next move</h3><SectionHelp title="Short-term forecast"/><span className="ml-auto text-[11px] text-muted">{bitcoin?'Select a range':'Bitcoin forecast · separate from YES'}</span></div>
    <div className="grid grid-cols-3 gap-2">{PRICE_HORIZONS.map(h=>{const p=predictions.find(p=>p.horizon===h),direction=ready?p?.direction??'UNCLEAR':'UNCLEAR';return <button key={h} type="button" aria-pressed={horizon===h} aria-label={`Show ${horizonLabel(h)} Bitcoin forecast`} onClick={()=>onSelect(h)} className={cn('min-w-0 rounded-xl border p-2 text-left transition-colors sm:p-3',horizon===h?'border-info/50 bg-info/5':'border-line bg-surface-2/40 hover:border-line-strong')}>
      <div className="flex items-center justify-between gap-1 text-xs text-muted"><span>{horizonLabel(h)}</span><span className="text-[10px]">{!ready?'Warming':p?.active?'Measured':'Learning'}</span></div>
      <div className={cn('mt-1 text-sm font-semibold',direction==='UP'?'text-yes':direction==='DOWN'?'text-no':'text-muted')}>{direction}</div>
      <div className="num mt-0.5 text-sm sm:text-lg">{ready&&p?`${pct(p.pUp,0)} up`:'—'}</div>
    </button>;})}</div>
    {ready&&selected?<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted"><span><span className="text-info">Estimated 80% range</span> · {dollars(selected.low)}–{dollars(selected.high)}</span><span>{horizonLabel(horizon)} ahead · {selected.active?'later-data test passed':selected.reason}</span></div>:<p role="status" className="mt-2 text-xs text-muted">{!fresh?'Forecast paused while live data is unavailable.':board?.reason??'Loading the price forecast…'}</p>}
    <details className="mt-2"><summary className="flex min-h-8 items-center gap-1 text-xs text-muted"><ChevronRight aria-hidden className="chev size-3.5"/>Measured results · {total} forward outcomes</summary>
      <p className="mb-3 mt-2 text-xs text-muted">Learns from candle bodies and wicks, momentum, range position and volatility. Later-data results test the candidate model; the Learning display stays at 50–50 until it qualifies. Live results use forecasts saved before their outcomes. This predicts Bitcoin price movement, not settlement or trading profit.</p>
      {ready&&selected?.drivers.length?<div className="mb-3 flex flex-wrap gap-2">{selected.drivers.map(d=><span key={d.name} className="rounded-md bg-surface-2 px-2 py-1 text-xs text-muted">{d.name} · {d.effect>0?'upward':'downward'} influence</span>)}</div>:null}
      <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="text-muted"><tr>{['Ahead','Later-data tests','Brier / 50–50','Range coverage','Live clear calls'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead><tbody>{PRICE_HORIZONS.map(h=>{const p=predictions.find(p=>p.horizon===h),v=p?.validation,l=board?.scores?.[h];return <tr key={h} className="border-t border-line"><th scope="row" className="py-2 pr-3 font-medium">{horizonLabel(h)}</th><td className="num pr-3">{v?.n??0}</td><td className="num pr-3">{v?.brier!=null?`${v.brier.toFixed(3)} / 0.250`:'—'}</td><td className="num pr-3">{pct(v?.coverage,0)}</td><td className="num">{l?.calls?`${l.hits}/${l.calls} correct`:'No clear calls'}<span className="ml-2 font-sans text-faint">{l?.n??0} scored · {l?.missing??0} missing · {l?.flat??0} flat</span></td></tr>;})}</tbody></table></div>
      <p className="mt-2 text-[11px] text-faint">Brier measures probability error; lower is better. A 50–50 forecast scores 0.250 on non-flat outcomes. Range coverage is the fraction inside the estimated 80% band. Flat prices and missing endpoints do not count as direction wins or losses. Results update every 30 seconds.</p>
      <a href="/api/engine/export/price_forecasts" className="mt-2 inline-block text-xs text-info hover:underline">Export live forecast record</a>
    </details>
  </section>;
}
