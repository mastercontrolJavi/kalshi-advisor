'use client';
import {memo} from 'react';
import {LineChart,Line,XAxis,YAxis,Tooltip,ResponsiveContainer,CartesianGrid} from 'recharts';
function ProbabilityChart({data}:{data:{time:number;model:number|null;market:number|null}[]}){
  return <div className="chart" role="img" aria-label="Model probability versus Kalshi midpoint over this market window"><ResponsiveContainer width="100%" height="100%"><LineChart data={data}><CartesianGrid stroke="#22272b" vertical={false}/><XAxis dataKey="time" tickFormatter={t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} minTickGap={70} stroke="#71717a"/><YAxis domain={[0,1]} tickFormatter={v=>`${Math.round(v*100)}%`} width={42} stroke="#71717a"/><Tooltip labelFormatter={t=>new Date(Number(t)).toLocaleTimeString()} formatter={(v,name)=>[v===null?'—':`${(Number(v)*100).toFixed(1)}%`,name]} contentStyle={{background:'#111518',border:'1px solid #30363a'}}/><Line name="Model" dataKey="model" type="linear" stroke="#34d399" dot={false} isAnimationActive={false} connectNulls={false}/><Line name="Kalshi mid" dataKey="market" type="linear" stroke="#818cf8" dot={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div>;
}
// State arrives 4×/s but history only gains a point per second; redraw only when the series actually changes.
export default memo(ProbabilityChart,(a,b)=>a.data.length===b.data.length&&a.data.at(-1)?.time===b.data.at(-1)?.time);
