'use client';
import {memo} from 'react';
import {LineChart,Line,XAxis,YAxis,Tooltip,ResponsiveContainer,CartesianGrid,ReferenceLine} from 'recharts';
// SVG presentation attributes cannot read CSS variables; these mirror the globals.css tokens.
// Mirrors the theme tokens in globals.css (charts draw on canvas and need the hex values).
export const chartColors={yes:'#5eead4',no:'#ff8a70',warn:'#ffc46b',info:'#9aa8ff',tactics:'#c4a5ff',grid:'#232a47',axis:'#8189ab',muted:'#a6acc9',surface:'#1e2440',line:'#3a4372'};
function ProbabilityChart({data}:{data:{time:number;model:number|null;market:number|null;quant?:number|null}[]}){
  if(!data.length)return <div className="chart flex items-center justify-center rounded-xl border border-dashed border-line text-sm text-muted">The chart fills in as this window runs.</div>;
  const last=data.at(-1);
  return <div className="chart" role="img" aria-label={`Model probability up ${last?.model!=null?Math.round(last.model*100)+'%':'unavailable'} versus Kalshi midpoint ${last?.market!=null?Math.round(last.market*100)+'%':'unavailable'} over this window`}><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{top:8,right:8,bottom:0,left:0}}>
    <CartesianGrid stroke={chartColors.grid} vertical={false}/>
    <XAxis dataKey="time" tickFormatter={t=>new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} minTickGap={70} stroke={chartColors.axis} tick={{fontSize:11}} tickLine={false}/>
    <YAxis domain={[0,1]} ticks={[0,.25,.5,.75,1]} tickFormatter={v=>`${Math.round(v*100)}%`} width={40} stroke={chartColors.axis} tick={{fontSize:11}} tickLine={false} axisLine={false}/>
    <ReferenceLine y={.5} stroke={chartColors.line} strokeDasharray="4 4"/>
    <Tooltip labelFormatter={t=>new Date(Number(t)).toLocaleTimeString()} formatter={(v,name)=>[v===null?'—':`${(Number(v)*100).toFixed(1)}%`,name]} contentStyle={{background:chartColors.surface,border:`1px solid ${chartColors.line}`,borderRadius:12,fontSize:12}}/>
    <Line name="Quant" dataKey="quant" type="linear" stroke={chartColors.yes} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false}/>
    <Line name="Model" dataKey="model" type="linear" stroke={chartColors.axis} strokeWidth={1.25} strokeDasharray="3 3" dot={false} isAnimationActive={false} connectNulls={false}/>
    <Line name="Kalshi mid" dataKey="market" type="linear" stroke={chartColors.info} strokeWidth={1.5} dot={false} isAnimationActive={false}/>
  </LineChart></ResponsiveContainer></div>;
}
// State arrives ~4×/s but history only gains a point per second; redraw only when the series actually changes.
export default memo(ProbabilityChart,(a,b)=>a.data.length===b.data.length&&a.data.at(-1)?.time===b.data.at(-1)?.time);
