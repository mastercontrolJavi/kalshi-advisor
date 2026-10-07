'use client';
import {useEffect,useRef,useState} from 'react';
import dynamic from 'next/dynamic';
import {LineChart as ChartIcon,BookOpen,Layers,Activity,ShieldCheck,SlidersHorizontal,ArrowUpRight,Volume2} from 'lucide-react';
import {useLive} from './use-live';
import Settings from './settings';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Card} from './ui/card';
import {SignalPanel,ForecastPanel,Instruments,Positions,BookLadder,MakerIdeas,Session,Feeds,Collapsible,WindowBar,Pill,actionTone} from './panels';
import {ago,signedDollars} from './format';
const ProbabilityChart=dynamic(()=>import('./probability-chart'),{ssr:false,loading:()=><div className="chart animate-pulse rounded-xl bg-surface-2"/>});

export default function Dashboard(){
  const {state:s,connected,fresh}=useLive(),[override,setOverride]=useState(''),[error,setError]=useState(''),[audioArmed,setAudioArmed]=useState(false);
  const lastSignal=useRef(''),audio=useRef<AudioContext|null>(null);
  useEffect(()=>{if(!s?.evaluation?.idea||!fresh)return;const i=s.evaluation.idea,key=[s.ticker,i.side,i.price].join(':');if(key===lastSignal.current)return;lastSignal.current=key;
    if(s.config.audio&&audioArmed&&audio.current){const ctx=audio.current,osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=880;gain.gain.setValueAtTime(.07,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.25);osc.connect(gain).connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.25);}
    if(s.config.notifications&&'Notification' in window&&Notification.permission==='granted')new Notification(s.evaluation.action,{body:s.evaluation.reason});
  },[s,fresh,audioArmed]);
  useEffect(()=>()=>{void audio.current?.close();},[]);
  async function unlock(){try{const r=await fetch('/api/engine/override',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:override})});const data=await r.json();if(!r.ok)throw new Error(data.error);setOverride('');}catch(e){setError((e as Error).message);}}
  const action=fresh?s?.evaluation?.action??'NO TRADE':'NO TRADE',tone=actionTone(action),healthy=s?.venues?.filter((v:any)=>v.healthy).length??0;
  const ambient=!fresh?'warn':tone==='yes'||tone==='no'?tone:'none';
  return <>
    <div aria-hidden className="ambient" data-tone={ambient}/>
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <a href="/" className="flex items-center gap-2.5"><img src="/icon.svg" alt="" width={28} height={28} className="size-7"/><span className="font-display text-xl font-bold tracking-wide">KALSHI<span className="text-yes">/ADVISOR</span></span></a>
        <span className="num hidden truncate text-xs text-muted sm:inline">{s?.market?.ticker??'waiting for market'}</span>
        <nav className="ml-auto flex items-center gap-2 text-sm">
          <Pill tone={fresh?'yes':'warn'}><span className={fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{fresh?'Live':connected?'Stale':'Reconnecting'}</Pill>
          <Pill tone={healthy===4?'neutral':'warn'} title="Exchange price feeds live">{healthy}/4 feeds</Pill>
          <span className="num hidden text-xs text-muted md:inline" title="Age of data on screen">{s?ago(Math.max(0,Date.now()-s.engineTime)):'—'}</span>
          <a className="inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-muted transition-colors hover:text-fg" href="/calibration">Calibration<ArrowUpRight aria-hidden className="size-4"/></a>
        </nav>
      </div>
      <WindowBar s={s}/>
    </header>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8"><SignalPanel s={s} fresh={fresh}/></div>
        <div className="lg:col-span-4"><ForecastPanel s={s} fresh={fresh}/></div>
      </div>
      <Positions s={s} fresh={fresh}/>
      <Instruments s={s}/>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8"><Collapsible open title="Probability over this window" icon={<ChartIcon aria-hidden className="size-4 text-info"/>} aside={<span className="flex gap-3"><span className="text-yes">— Model</span><span className="text-info">— Kalshi mid</span></span>}><ProbabilityChart data={s?.history??[]}/></Collapsible></div>
        <div className="lg:col-span-4"><Collapsible open title="Order book" icon={<BookOpen aria-hidden className="size-4 text-info"/>} aside="top 10 bids"><BookLadder s={s}/></Collapsible></div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Collapsible open title="Session & guardrails" icon={<ShieldCheck aria-hidden className="size-4 text-info"/>} aside={<span className="num">{signedDollars(s?.guards?.pnl)}</span>}><Session s={s}/></Collapsible>
        <Collapsible open title="Resting-bid ideas" icon={<Layers aria-hidden className="size-4 text-info"/>} aside={`${fresh?s?.evaluation?.makers?.length??0:0} now`}><MakerIdeas s={s} fresh={fresh}/></Collapsible>
        <Collapsible open title="Feeds & latency" icon={<Activity aria-hidden className="size-4 text-info"/>} aside={s?.quality?.level}><Feeds s={s}/></Collapsible>
      </div>
      <Collapsible title="Settings & alerts" icon={<SlidersHorizontal aria-hidden className="size-4 text-info"/>} aside="thresholds, sizing, guardrails">
        {s?.config?<Settings config={s.config}/>:<p className="text-muted">Waiting for engine</p>}
        <Button className="mt-5" variant="outline" onClick={()=>{audio.current??=new AudioContext();void audio.current.resume();setAudioArmed(true);}}><Volume2 aria-hidden className="size-4"/>{audioArmed?'Audio armed for this browser':'Enable browser audio'}</Button>
      </Collapsible>
      <footer className="flex flex-wrap justify-between gap-3 pt-2 text-xs text-faint"><span>Next: <span className="num">{s?.next?.ticker??'discovering'}</span> · journal stays in ./data/advisor.db · orders disabled</span><a className="underline-offset-4 hover:text-fg hover:underline" href="/api/engine/export/signals">Export signals CSV</a></footer>
    </main>
    {s?.guards?.dailyLocked?<div role="dialog" aria-modal="true" aria-labelledby="lock-title" className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-5 backdrop-blur"><Card className="max-w-md space-y-5 border-no/40">
      <div className="label text-no">Daily discipline lock</div><h1 id="lock-title" className="font-display text-7xl font-bold text-no">LOCKED</h1>
      <p className="text-fg/90">Daily loss limit reached. Signals stay suppressed for the rest of the local day.</p><p className="text-sm text-muted">Override requires typing “I accept the risk”. This action is logged.</p>
      <label className="block space-y-2"><span className="label">Risk acknowledgement</span><Input value={override} onChange={e=>setOverride(e.target.value)} autoComplete="off"/></label>
      <Button disabled={override!=='I accept the risk'} onClick={unlock}>Override daily lock</Button><p role="alert" className="text-sm text-no">{error}</p></Card></div>:null}
  </>;
}
