'use client';
import {useEffect,useRef,useState} from 'react';
import {createChart,CandlestickSeries,LineSeries,LineStyle,LineType,type IChartApi,type ISeriesApi,type UTCTimestamp,type Time} from 'lightweight-charts';
import {chartColors as k} from './probability-chart';
import {aggregate,addPrice,kPoints,bucketOf,type Candle,type Round} from './candles';
import {cn} from '@/lib/utils';
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
export default function PriceChart({s}:{s:any}){
  const box=useRef<HTMLDivElement>(null),chart=useRef<IChartApi|null>(null),main=useRef<ISeriesApi<'Candlestick'>|null>(null),extra=useRef<ISeriesApi<'Line'>[]>([]);
  const samples=useRef<[number,number][]>([]),rounds=useRef<Round[]>([]),candles=useRef<Candle[]>([]);
  const [view,setView]=useState<View>('btc'),[tf,setTf]=useState(15),[loaded,setLoaded]=useState(0),[error,setError]=useState('');
  useEffect(()=>{try{const v=JSON.parse(localStorage.getItem(KEY)??'null');if(v&&(v.view==='btc'||v.view==='kalshi')&&TFS[v.view as View].some(([x])=>x===v.tf)){setView(v.view);setTf(v.tf);}}catch{}},[]);
  const choose=(v:View,t:number)=>{setView(v);setTf(t);try{localStorage.setItem(KEY,JSON.stringify({view:v,tf:t}));}catch{}};
  useEffect(()=>{const el=box.current;if(!el)return;
    const c=createChart(el,{autoSize:true,layout:{background:{color:'transparent'},textColor:k.axis,fontSize:11,fontFamily:'inherit'},grid:{vertLines:{visible:false},horzLines:{color:k.grid}},
      rightPriceScale:{borderVisible:false,scaleMargins:{top:.12,bottom:.08}},timeScale:{borderVisible:false,timeVisible:true,secondsVisible:true,rightOffset:3,tickMarkFormatter:hhmm},
      crosshair:{vertLine:{color:k.line,labelBackgroundColor:k.surface},horzLine:{color:k.line,labelBackgroundColor:k.surface}},localization:{timeFormatter:(t:Time)=>new Date(Number(t)*1000).toLocaleTimeString()}});
    chart.current=c;return()=>{c.remove();chart.current=null;main.current=null;extra.current=[];};},[]);
  useEffect(()=>{let stop=false;const load=async()=>{try{const r=await fetch('/api/engine/candles',{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);const d=await r.json();if(stop)return;samples.current=d.samples??[];rounds.current=d.rounds??[];setLoaded(Date.now());setError('');}catch(e){if(!stop)setError((e as Error).message);}};
    void load();const t=setInterval(()=>void load(),60000);return()=>{stop=true;clearInterval(t);};},[]);
  const ticker=s?.market?.ticker??null;
  // The current round's K joins the list as soon as the engine knows it (rounds from the server lag up to a minute).
  const withCurrent=():Round[]=>{const m=s?.market,K=s?.K;if(!m||!(K>0))return rounds.current;const cur={ticker:m.ticker,open:Date.parse(m.open_time),close:Date.parse(m.close_time),k:K};return [...rounds.current.filter(r=>r.ticker!==m.ticker),cur];};
  // Rebuild the series when the view, timeframe, history or (for Kalshi) the round changes.
  useEffect(()=>{const c=chart.current;if(!c)return;
    if(main.current)c.removeSeries(main.current);for(const l of extra.current)c.removeSeries(l);extra.current=[];
    const btc=view==='btc',fmt=btc?{type:'price' as const,precision:2,minMove:.01}:{type:'price' as const,precision:1,minMove:.1};
    const m=c.addSeries(CandlestickSeries,{upColor:k.yes,downColor:k.no,wickUpColor:k.yes,wickDownColor:k.no,borderVisible:false,priceFormat:fmt,priceLineColor:k.muted});main.current=m;
    if(btc){candles.current=aggregate(samples.current,tf);m.setData(candles.current.map(x=>({...x,time:ts(x.time)})));
      const kl=c.addSeries(LineSeries,{color:k.warn,lineWidth:1,lineStyle:LineStyle.Dashed,lineType:LineType.WithSteps,priceLineVisible:false,lastValueVisible:true,title:'K',crosshairMarkerVisible:false,priceFormat:fmt});
      kl.setData(kPoints(withCurrent(),candles.current).map(p=>({...p,time:ts(p.time)})));extra.current=[kl];}
    else{const h:any[]=(s?.history??[]).filter((x:any)=>x.market!=null);candles.current=aggregate(h.map(x=>[x.time,x.market*100]),tf);m.setData(candles.current.map(x=>({...x,time:ts(x.time)})));
      m.createPriceLine({price:50,color:k.line,lineWidth:1,lineStyle:LineStyle.Dotted,axisLabelVisible:false,title:''});
      const line=(key:'quant'|'model',color:string,style:LineStyle)=>{const l=c.addSeries(LineSeries,{color,lineWidth:key==='quant'?2:1,lineStyle:style,priceLineVisible:false,lastValueVisible:key==='quant',crosshairMarkerVisible:false,title:key==='quant'?'Quant':'',priceFormat:fmt});
        const pts=new Map<number,number>();for(const x of s?.history??[])if(x[key]!=null)pts.set(bucketOf(x.time,tf),x[key]*100);l.setData([...pts].map(([t,v])=>({time:ts(t),value:v})));return l;};
      extra.current=[line('quant',k.yes,LineStyle.Solid),line('model',k.axis,LineStyle.Dashed)];}
    const n=candles.current.length;if(n)c.timeScale().setVisibleLogicalRange({from:Math.max(0,n-SHOWN),to:n+3});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[view,tf,loaded,view==='kalshi'?ticker:null]);
  // Live: each state update moves the last candle (and the K / forecast lines) without redrawing the history.
  useEffect(()=>{const m=main.current;if(!m||!s?.engineTime)return;const t=s.engineTime;
    if(view==='btc'){if(!(s.proxy>0))return;samples.current.push([t,s.proxy]);if(samples.current.length>8000)samples.current.splice(0,samples.current.length-7200);
      const c=addPrice(candles.current,t,s.proxy,tf);if(!c)return;m.update({...c,time:ts(c.time)});
      const r=withCurrent().find(x=>t>=x.open&&t<x.close);if(r)extra.current[0]?.update({time:ts(c.time),value:r.k});}
    else{const b=s.book,mid=b?.yesBid!=null&&b?.yesAsk!=null?(b.yesBid+b.yesAsk)/2*100:null;if(mid==null)return;const c=addPrice(candles.current,t,mid,tf);if(!c)return;m.update({...c,time:ts(c.time)});
      if(s.quant?.p!=null)extra.current[0]?.update({time:ts(c.time),value:s.quant.p*100});if(s.quant?.model!=null)extra.current[1]?.update({time:ts(c.time),value:s.quant.model*100});}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[s?.engineTime]);
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
    <div ref={box} role="img" aria-label={label} className="chart-tall mt-3"/>
    {error?<p className="mt-2 text-xs text-warn">Price history unavailable ({error}); showing live prices only.</p>
      :<p className="mt-2 text-xs text-faint">{view==='btc'?'The model\'s own spot (median of 4 exchanges, ~$1 from Kalshi\'s BRTI). Kalshi settles on the last 60 s average against K.':'YES mid this round; green is the quant forecast the signals use, dashed the raw model. Gaps are seconds with no two-sided book.'}</p>}
  </div>;
}
