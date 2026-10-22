'use client';
import {ResponsiveContainer,LineChart,Line,BarChart,Bar,XAxis,YAxis,Tooltip,CartesianGrid,ReferenceLine,Cell,Legend} from 'recharts';
import {chartColors as k} from './probability-chart';
const tooltip={background:k.surface,border:`1px solid ${k.line}`,borderRadius:12,fontSize:12};
const money=(v:number)=>`${v<0?'−':''}$${Math.abs(v).toFixed(2)}`;
const date=(t:number)=>new Date(t).toLocaleDateString([],{month:'short',day:'numeric'});
export function EquityChart({data}:{data:{time:number;pnl:number}[]}){
  return <div className="chart" role="img" aria-label={`Cumulative realized P&L, now ${money(data.at(-1)?.pnl??0)}`}><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{top:8,right:8,bottom:0,left:0}}>
    <CartesianGrid stroke={k.grid} vertical={false}/><XAxis dataKey="time" tickFormatter={date} minTickGap={60} stroke={k.axis} tick={{fontSize:11}} tickLine={false}/>
    <YAxis tickFormatter={money} width={56} stroke={k.axis} tick={{fontSize:11}} tickLine={false} axisLine={false}/><ReferenceLine y={0} stroke={k.line}/>
    <Tooltip contentStyle={tooltip} labelFormatter={t=>new Date(Number(t)).toLocaleString()} formatter={v=>[money(Number(v)),'Cumulative P&L']}/>
    <Line dataKey="pnl" type="stepAfter" stroke={k.yes} strokeWidth={2} dot={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div>;
}
export function DailyChart({data}:{data:{day:string;pnl:number;markets:number}[]}){
  return <div className="chart" role="img" aria-label="Realized P&L per day"><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{top:8,right:8,bottom:0,left:0}}>
    <CartesianGrid stroke={k.grid} vertical={false}/><XAxis dataKey="day" stroke={k.axis} tick={{fontSize:11}} tickLine={false}/><YAxis tickFormatter={money} width={56} stroke={k.axis} tick={{fontSize:11}} tickLine={false} axisLine={false}/>
    <ReferenceLine y={0} stroke={k.line}/><Tooltip contentStyle={tooltip} formatter={(v,_n,p)=>[`${money(Number(v))} · ${(p.payload as any).markets} markets`,'Day']}/>
    <Bar dataKey="pnl" radius={[4,4,0,0]} isAnimationActive={false}>{data.map(d=><Cell key={d.day} fill={d.pnl>=0?k.yes:k.no}/>)}</Bar></BarChart></ResponsiveContainer></div>;
}
export function TrendChart({data}:{data:{time:number;avgPnl:number|null;winRate:number}[]}){
  return <div className="chart" role="img" aria-label="Rolling 10-market average P&L and win rate"><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{top:8,right:8,bottom:0,left:0}}>
    <CartesianGrid stroke={k.grid} vertical={false}/><XAxis dataKey="time" tickFormatter={date} minTickGap={60} stroke={k.axis} tick={{fontSize:11}} tickLine={false}/>
    <YAxis yAxisId="pnl" tickFormatter={money} width={56} stroke={k.axis} tick={{fontSize:11}} tickLine={false} axisLine={false}/>
    <YAxis yAxisId="win" orientation="right" domain={[0,1]} tickFormatter={v=>`${Math.round(v*100)}%`} width={40} stroke={k.axis} tick={{fontSize:11}} tickLine={false} axisLine={false}/>
    <ReferenceLine yAxisId="pnl" y={0} stroke={k.line}/><Tooltip contentStyle={tooltip} labelFormatter={t=>new Date(Number(t)).toLocaleString()} formatter={(v,n)=>[n==='Win rate'?`${(Number(v)*100).toFixed(0)}%`:money(Number(v)),n]}/><Legend/>
    <Line yAxisId="pnl" name="Avg P&L / market" dataKey="avgPnl" stroke={k.yes} strokeWidth={2} dot={false} isAnimationActive={false}/>
    <Line yAxisId="win" name="Win rate" dataKey="winRate" stroke={k.info} strokeWidth={1.5} dot={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div>;
}
