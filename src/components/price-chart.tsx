'use client';
import {useEffect,useRef,useState} from 'react';
import {createChart,CandlestickSeries,LineSeries,LineStyle,LineType,type IChartApi,type ISeriesApi,type UTCTimestamp,type Time} from 'lightweight-charts';
import {chartColors as k} from './probability-chart';
import {aggregate,addPrice,kPoints,bucketOf,mergeSamples,type Candle,type Round} from './candles';
import {cn} from '@/lib/utils';
import {usableMid} from '@/engine/quant/quote';
import {LocateFixed} from 'lucide-react';
import ShortTermForecast from './short-term-forecast';
import {priceProjection,type PricePrediction} from '@/engine/quant/price-forecast';
import {PriceProjectionBand} from './price-projection';
type View='btc'|'kalshi';
const TFS:Record<View,[number,string][]>={btc:[[5,'5s'],[15,'15s'],[60,'1m'],[300,'5m']],kalshi:[[5,'5s'],[15,'15s'],[60,'1m']]};
const SHOWN=120,KEY='panel:price-chart:view';
const chip=(on:boolean)=>cn('inline-flex min-h-9 cursor-pointer items-center rounded-xl px-3 text-sm transition-colors',on?'bg-surface-2 text-fg':'text-muted hover:text-fg');
const ts=(t:number)=>t as UTCTimestamp;
const hhmm=(t:Time)=>new Date(Number(t)*1000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
/**
 * Live candles: Bitcoin (the model's own 4-venue spot, with each round's opening price K as a dashed step line) or this
 * round's Kalshi YES price (with the quant forecast and the raw model as lines). History comes from /api/engine/candles
 * (the last 2 h of 1-s prices) and is refreshed every minute; between those, every 4 Hz state update moves the last candle.
 */
export default function PriceChart({s,fresh=true}:{s:any;fresh?:boolean}){
  const box=useRef<HTMLDivElement>(null),chart=useRef<IChartApi|null>(null),main=useRef<ISeriesApi<'Candlestick'>|null>(null),extra=useRef<ISeriesApi<'Line'>[]>([]);
  const samples=useRef<[number,number][]>([]),rounds=useRef<Round[]>([]),candles=useRef<Candle[]>([]),selection=useRef(''),lastUpdate=useRef(0),previousLoad=useRef(0);
  const projection=useRef<{lines:ISeriesApi<'Line'>[];band:PriceProjectionBand}|null>(null);
  // Last time on each overlay line. History times carry Kalshi's clock offset and the quant line includes seconds with no
  // two-sided book, so a live point can fall behind a line's end; lightweight-charts throws on that, so skip it instead.
  const ends=useRef(new WeakMap<ISeriesApi<'Line'>,number>());
  const extend=(l:ISeriesApi<'Line'>|undefined,time:number,value:number)=>{if(!l||!Number.isFinite(value)||time<(ends.current.get(l)??-Infinity))return;l.update({time:ts(time),value});ends.current.set(l,time);};
  const [horizon,setHorizon]=useState(60);
  const [view,setView]=useState<View>('btc'),[tf,setTf]=useState(15),[loaded,setLoaded]=useState(0),[error,setError]=useState('');
  useEffect(()=>{try{const v=JSON.parse(localStorage.getItem(KEY)??'null');if(v&&(v.view==='btc'||v.view==='kalshi')&&TFS[v.view as View].some(([x])=>x===v.tf)){setView(v.view);setTf(v.tf);}}catch{}},[]);
  const choose=(v:View,t:number)=>{setView(v);setTf(t);try{localStorage.setItem(KEY,JSON.stringify({view:v,tf:t}));}catch{}};
  useEffect(()=>{const el=box.current;if(!el)return;
    const c=createChart(el,{autoSize:true,layout:{background:{color:'transparent'},textColor:k.axis,fontSize:11,fontFamily:'inherit'},grid:{vertLines:{visible:false},horzLines:{color:k.grid}},
      rightPriceScale:{borderVisible:false,scaleMargins:{top:.12,bottom:.08}},timeScale:{borderVisible:false,timeVisible:true,secondsVisible:true,rightOffset:3,tickMarkFormatter:hhmm},
      crosshair:{vertLine:{color:k.line,labelBackgroundColor:k.surface},horzLine:{color:k.line,labelBackgroundColor:k.surface}},localization:{timeFormatter:(t:Time)=>new Date(Number(t)*1000).toLocaleTimeString()}});
    chart.current=c;return()=>{c.remove();chart.current=null;main.current=null;extra.current=[];projection.current=null;};},[]);
  useEffect(()=>{let stop=false,pending:AbortController|null=null;const load=async()=>{if(pending)return;const controller=new AbortController();pending=controller;const timeout=setTimeout(()=>controller.abort(),10000);try{const r=await fetch('/api/engine/candles',{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error(`HTTP ${r.status}`);const d=await r.json();if(stop)return;samples.current=mergeSamples(d.samples??[],samples.current,Date.now()-7200000);rounds.current=d.rounds??[];setLoaded(Date.now());setError('');}catch(e){if(!stop)setError((e as Error).message);}finally{clearTimeout(timeout);pending=null;}};
    void load();const t=setInterval(()=>void load(),60000);return()=>{stop=true;clearInterval(t);pending?.abort();};},[]);
  const ticker=s?.market?.ticker??null;
  // The current round's K joins the list as soon as the engine knows it (rounds from the server lag up to a minute).
  const withCurrent=():Round[]=>{const m=s?.market,K=s?.K;if(!m||!(K>0))return rounds.current;const cur={ticker:m.ticker,open:Date.parse(m.open_time),close:Date.parse(m.close_time),k:K};return [...rounds.current.filter(r=>r.ticker!==m.ticker),cur];};
  // Rebuild the series when the view, timeframe, history or (for Kalshi) the round changes.
  useEffect(()=>{const c=chart.current;if(!c)return;
    // The first history response replaces a tiny live-only range. Later refreshes preserve the user's zoom.
    const key=`${view}:${tf}:${view==='kalshi'?ticker:''}`,same=selection.current===key&&previousLoad.current>0,range=same?c.timeScale().getVisibleLogicalRange():null,timeRange=same?c.timeScale().getVisibleRange():null,following=range?range.to>=candles.current.length-2:true;selection.current=key;previousLoad.current=loaded;lastUpdate.current=0;
    if(projection.current){for(const l of projection.current.lines)c.removeSeries(l);projection.current=null;}
    if(main.current)c.removeSeries(main.current);for(const l of extra.current)c.removeSeries(l);extra.current=[];
    const btc=view==='btc',fmt=btc?{type:'price' as const,precision:2,minMove:.01}:{type:'price' as const,precision:1,minMove:.1};
    const m=c.addSeries(CandlestickSeries,{upColor:k.yes,downColor:k.no,wickUpColor:k.yes,wickDownColor:k.no,borderVisible:false,priceFormat:fmt,priceLineColor:k.muted});main.current=m;
    if(btc){candles.current=aggregate(samples.current,tf);m.setData(candles.current.map(x=>({...x,time:ts(x.time)})));
      const kl=c.addSeries(LineSeries,{color:k.warn,lineWidth:1,lineStyle:LineStyle.Dashed,lineType:LineType.WithSteps,priceLineVisible:false,lastValueVisible:true,title:'K',crosshairMarkerVisible:false,priceFormat:fmt});
      const kp=kPoints(withCurrent(),candles.current);kl.setData(kp.map(p=>({...p,time:ts(p.time)})));ends.current.set(kl,kp.at(-1)?.time??-Infinity);extra.current=[kl];}
    else{const h:any[]=(s?.history??[]).filter((x:any)=>x.market!=null);candles.current=aggregate(h.map(x=>[x.time,x.market*100]),tf);m.setData(candles.current.map(x=>({...x,time:ts(x.time)})));
      m.createPriceLine({price:50,color:k.line,lineWidth:1,lineStyle:LineStyle.Dotted,axisLabelVisible:false,title:''});
      const line=(key:'quant'|'model',color:string,style:LineStyle)=>{const l=c.addSeries(LineSeries,{color,lineWidth:key==='quant'?2:1,lineStyle:style,priceLineVisible:false,lastValueVisible:key==='quant',crosshairMarkerVisible:false,title:key==='quant'?'Quant':'',priceFormat:fmt});
        const pts=new Map<number,number>();for(const x of s?.history??[])if(x[key]!=null)pts.set(bucketOf(x.time,tf),x[key]*100);const sorted=[...pts].sort((a,b)=>a[0]-b[0]);l.setData(sorted.map(([t,v])=>({time:ts(t),value:v})));ends.current.set(l,sorted.at(-1)?.[0]??-Infinity);return l;};
      extra.current=[line('quant',k.yes,LineStyle.Solid),line('model',k.axis,LineStyle.Dashed)];}
    const n=candles.current.length;if(n){if(same&&timeRange&&!following)c.timeScale().setVisibleRange(timeRange);else {const span=same&&range?range.to-range.from:SHOWN+3;c.timeScale().setVisibleLogicalRange({from:Math.max(0,n+3-span),to:n+3});}}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[view,tf,loaded,view==='kalshi'?ticker:null]);
  // Live: each state update moves the last candle (and the K / forecast lines) without redrawing the history.
  useEffect(()=>{const m=main.current;if(!m||!s?.engineTime||!fresh)return;const t=s.engineTime;if(t<=lastUpdate.current)return;lastUpdate.current=t;
    if(view==='btc'){if(!(s.proxy>0))return;samples.current.push([t,s.proxy]);while(samples.current.length&&samples.current[0][0]<t-7200000)samples.current.shift();
      const c=addPrice(candles.current,t,s.proxy,tf);if(!c)return;m.update({...c,time:ts(c.time)});
      const r=withCurrent().find(x=>t>=x.open&&t<x.close);if(r)extend(extra.current[0],c.time,r.k);}
    else{const b=s.book,price=b?usableMid(b,t,s?.config?.bookStaleMs??5000,1):null,mid=price===null?null:price*100;if(mid==null)return;const c=addPrice(candles.current,t,mid,tf);if(!c)return;m.update({...c,time:ts(c.time)});
      if(s.quant?.p!=null)extend(extra.current[0],c.time,s.quant.p*100);if(s.quant?.model!=null)extend(extra.current[1],c.time,s.quant.model*100);}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[s?.engineTime,fresh,view,tf,loaded]);
  // Future projections are independent line series: they can never become observed candles or leak into OHLC.
  useEffect(()=>{const c=chart.current;if(!c)return;
    const p:PricePrediction|undefined=s?.shortTerm?.horizons?.find((p:PricePrediction)=>p.horizon===horizon);
    if(view!=='btc'||!fresh||!s?.shortTerm?.ready||!p){if(projection.current){for(const l of projection.current.lines)c.removeSeries(l);projection.current=null;}return;}
    const range=c.timeScale().getVisibleRange(),following=!range||Number(range.to)>=Number(candles.current.at(-1)?.time??Infinity),width=c.timeScale().getVisibleLogicalRange();
    if(!projection.current){const lines=[0,1,2].map(i=>c.addSeries(LineSeries,{color:i===0?k.info:'rgba(116,173,255,0.4)',lineWidth:i===0?2:1,lineStyle:LineStyle.Dashed,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,priceFormat:{type:'price',precision:2,minMove:.01}}));const band=new PriceProjectionBand(c,lines[0]);lines[0].attachPrimitive(band);projection.current={lines,band};}
    const points=priceProjection(p,tf);for(const [i,key] of (['expected','low','high'] as const).entries())projection.current.lines[i].setData(points.map(x=>({time:ts(x.time),value:x[key]})));projection.current.band.setData(points);
    if(following){const end=c.timeScale().timeToIndex(ts(points.at(-1)!.time),false);if(end!==null){const span=width?width.to-width.from:SHOWN+3;c.timeScale().setVisibleLogicalRange({from:Math.max(0,end+3-span),to:end+3});}}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[s?.shortTerm?.time,horizon,view,tf,loaded,fresh]);
  function latest(){const c=chart.current;if(!c)return;const p:PricePrediction|undefined=view==='btc'&&projection.current?s?.shortTerm?.horizons?.find((p:PricePrediction)=>p.horizon===horizon):undefined;
    const endTime=p?Math.floor(p.targetTime/1000):candles.current.at(-1)?.time;if(endTime===undefined)return;const end=c.timeScale().timeToIndex(ts(endTime),true);if(end!==null)c.timeScale().setVisibleLogicalRange({from:Math.max(0,end-SHOWN),to:end+3});}
  const last=candles.current.at(-1),K=s?.K,diff=view==='btc'&&last&&K>0?last.close-K:null;
  const label=view==='btc'?`Bitcoin ${tf}-second candles${last?`, last $${last.close.toFixed(2)}`:''}${diff!=null?`, ${diff>=0?'above':'below'} the opening price by $${Math.abs(diff).toFixed(2)}`:''}`:`Kalshi YES price candles this round${last?`, last ${last.close.toFixed(1)} cents`:''}`;
  return <div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div role="group" aria-label="Chart" className="flex gap-1">{([['btc','Bitcoin'],['kalshi','Kalshi YES']] as [View,string][]).map(([v,l])=><button key={v} type="button" aria-pressed={view===v} onClick={()=>choose(v,TFS[v].some(([x])=>x===tf)?tf:15)} className={cn(chip(view===v),'font-medium')}>{l}</button>)}</div>
      <div role="group" aria-label="Candle length" className="flex gap-1">{TFS[view].map(([x,l])=><button key={x} type="button" aria-pressed={tf===x} onClick={()=>choose(view,x)} className={chip(tf===x)}>{l}</button>)}</div>
      <div className="ml-auto flex flex-wrap items-baseline gap-x-3 text-sm">{view==='btc'?<>
        <span className="num text-lg font-semibold">{last?`$${last.close.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`:'—'}</span>
        {diff!=null?<span className={cn('num',diff>=0?'text-yes':'text-no')}>{diff>=0?'+':'−'}${Math.abs(diff).toFixed(2)} vs K</span>:null}
        <span className="flex items-center gap-1.5 text-xs text-muted"><span aria-hidden className="inline-block w-4 border-t border-dashed border-warn"/>K (opening price)</span></>
        :<><span className="num text-lg font-semibold">{last?`${last.close.toFixed(1)}¢`:'—'}</span><span className="flex items-center gap-1.5 text-xs text-muted"><span aria-hidden className="inline-block h-0.5 w-4 bg-yes"/>Quant <span aria-hidden className="ml-1 inline-block w-4 border-t border-dashed border-faint"/>Model</span></>}</div>
    </div>
    <div className="relative"><div ref={box} role="img" aria-label={label} className="chart-tall mt-3"/>
      {!candles.current.length?<div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">{error?'Waiting for live prices':loaded?(view==='kalshi'?'Waiting for a live two-sided Kalshi book':'Waiting for price samples'):'Loading price history…'}</div>:null}
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>{fresh?'Live updates':'Updates paused'} · {candles.current.length} candles</span>{view==='btc'&&fresh&&s?.shortTerm?.ready?<span className="text-info">Dashed + shade: {horizon===30?'30s':horizon===60?'1m':'3m'} estimate · 80% range</span>:null}<button type="button" className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 hover:bg-surface-2 hover:text-fg" onClick={latest}><LocateFixed aria-hidden className="size-3.5"/>Latest</button></div>
    {error?<p className="mt-2 text-xs text-warn">Price history unavailable ({error}); showing live prices only.</p>
      :<p className="mt-2 text-xs text-faint">{view==='btc'?'The model\'s own spot (median of healthy exchange feeds; may differ from official BRTI). Kalshi settles on the last 60 s average against K.':'YES mid this round; green is the quant forecast the signals use, dashed the raw model. Gaps are seconds with no two-sided book.'}</p>}
    <ShortTermForecast board={s?.shortTerm??null} fresh={fresh} horizon={horizon} onSelect={setHorizon} bitcoin={view==='btc'}/>
  </div>;
}
