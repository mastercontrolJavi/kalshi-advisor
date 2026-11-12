'use client';
import {useMemo,useState} from 'react';
import dynamic from 'next/dynamic';
import {ChartCandlestick,BookOpen,Layers,Activity,ShieldCheck,SlidersHorizontal,BellRing,History,Waves,Scale} from 'lucide-react';
import {flowAlignment} from '@/engine/flow';
import {useSoundAlerts} from './use-sound-alerts';
import {SoundPanel,SoundToggle} from './sound-panel';
import {useLive} from './use-live';
import Settings from './settings';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Card} from './ui/card';
import {SignalPanel,ForecastPanel,Instruments,Positions,BookLadder,MakerIdeas,Session,Feeds,Collapsible,WindowBar,Pill,RecentRounds,DataUpdate,StaleBanner,actionTone} from './panels';
import {SiteHeader} from './site-header';
import {SectionHelp} from './section-help';
import {FlowPulse} from './flow-pulse';
import {EdgePanel,EdgeBanner} from './edge-panel';
import {MasterSignal} from './master-signal';
import {PanelBoundary} from './panel-boundary';
import {cn} from '@/lib/utils';
import {ago,signedDollars} from './format';
import {finalMinuteEvidence} from '@/backtest/verdict';
import {fillMarks,type RoundFill} from './candles';
const PriceChart=dynamic(()=>import('./price-chart'),{ssr:false,loading:()=><div className="chart-tall animate-pulse rounded-xl bg-surface-2"/>});

export default function Dashboard(){
  const {state:s,connected,fresh}=useLive(),[override,setOverride]=useState(''),[error,setError]=useState(''),sound=useSoundAlerts(s,fresh);
  async function unlock(){try{const r=await fetch('/api/engine/override',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:override})});const data=await r.json();if(!r.ok)throw new Error(data.error);setOverride('');}catch(e){setError((e as Error).message);}}
  // Your real fills this round as buy/sell arrows on the chart; the key keeps the marks from being reset 4 times a second.
  const fills:RoundFill[]=s?.roundFills??[],fillKey=fills.map(f=>`${f.time}:${f.side}:${f.contracts}:${f.closedContracts}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marks=useMemo(()=>fillMarks(fills),[fillKey]);
  const action=fresh?s?.evaluation?.action??'NO TRADE':'NO TRADE',tone=actionTone(action),healthy=s?.venues?.filter((v:any)=>v.healthy).length??0;
  const ambient=!fresh?'warn':tone==='yes'||tone==='no'?tone:'none',holding=fresh&&(s?.exits?.length??0)>0;
  return <>
    <div aria-hidden className="ambient" data-tone={ambient}/>
    <SiteHeader current="/" bottom={<WindowBar s={s}/>} aside={<span className="num hidden truncate text-xs text-muted xl:inline">{s?.market?.ticker??'waiting for market'}</span>}>
      <SoundToggle prefs={sound.prefs} setPrefs={sound.setPrefs} ready={sound.ready}/>
      <Pill tone={fresh?'yes':'warn'}><span className={fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{fresh?'Live':connected?'Stale':'Reconnecting'}</Pill>
      <Pill tone={healthy===4?'neutral':'warn'} title="Exchange price feeds live">{healthy}/4 feeds</Pill>
      <span className="num hidden text-xs text-muted md:inline" title="Age of data on screen">{s?ago(Math.max(0,Date.now()-s.engineTime)):'—'}</span>
    </SiteHeader>
    <main className="mx-auto max-w-[1600px] space-y-4 px-4 pt-4 pb-16 sm:px-6 3xl:max-w-[2400px] 4xl:max-w-[3200px]">
      <PanelBoundary name="Master signal"><MasterSignal s={s} fresh={fresh}/></PanelBoundary>
      <DataUpdate s={s}/>
      {fresh?<StaleBanner s={s}/>:null}
      <EdgeBanner s={s} fresh={fresh}/>
      <Instruments s={s}/>
      {!fresh?<div role="status" className="rounded-xl border border-warn/40 bg-warn-dim/30 px-4 py-2 text-sm text-warn">{connected?'Updates are stale':'Reconnecting to the engine'} · entry and exit advice paused. Chart history remains available.</div>:null}
      {/* One grid, three working areas. From 1024 px the chart sets the row height and the decision/positions column
          scrolls inside it, so a new position never pushes the rest of the page down (2026-10-22). From 1920 px (27-32 in)
          the calls and the order book move up beside the chart as a third column instead of sitting below the fold. */}
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="min-w-0 p-0 lg:col-span-8 3xl:col-span-6">
          <div className="flex min-h-12 items-center gap-2 border-b border-line px-4 py-2"><ChartCandlestick aria-hidden className="size-4 text-info"/><h2 className="font-medium">Price action</h2><SectionHelp title="Price action"/><span className="ml-auto hidden text-xs text-muted sm:inline">Live candles</span></div>
          <div className="p-4"><PanelBoundary name="Price chart"><PriceChart s={s} fresh={fresh} marks={marks}/></PanelBoundary></div>
        </Card>
        <div className="relative min-w-0 lg:col-span-4 3xl:col-span-3"><div className="flex flex-col gap-4 lg:absolute lg:inset-0 lg:overflow-y-auto lg:pr-1 lg:[scrollbar-gutter:stable]">
          {holding?<><Positions s={s} fresh={fresh} compact/><SignalPanel s={s} fresh={fresh} compact/></>:<><SignalPanel s={s} fresh={fresh} compact/><Positions s={s} fresh={fresh} compact/></>}</div></div>
        <div className="relative min-w-0 lg:col-span-12 3xl:col-span-3"><div className="grid gap-4 lg:grid-cols-12 3xl:absolute 3xl:inset-0 3xl:flex 3xl:flex-col 3xl:overflow-y-auto 3xl:pr-1 3xl:[scrollbar-gutter:stable]">
          <div className="min-w-0 lg:col-span-8"><ForecastPanel s={s} fresh={fresh}/></div>
          <div className="min-w-0 lg:col-span-4"><Collapsible open remember="order-book" title="Order book" icon={<BookOpen aria-hidden className="size-4 text-info"/>} aside="top 10 bids"><BookLadder s={s}/></Collapsible></div>
          <div className="min-w-0 lg:col-span-12"><Collapsible open remember="edge-layer" title="Edge layer" icon={<Scale aria-hidden className="size-4 text-info"/>} aside={fresh&&s?.edge?s.edge.status==='OFFLINE'?'offline':s.edge.action==='TRADE'?`TRADE ${String(s.edge.side).toUpperCase()}`:s.edge.action==='BLOCKED'?'blocked':s.edge.action==='MODEL_DISAGREE'?'model disagrees':s.edge.status==='IDLE'?'between windows':'no edge':'—'}><PanelBoundary name="Edge layer"><EdgePanel s={s} fresh={fresh}/></PanelBoundary></Collapsible></div>
          <div className="min-w-0 lg:col-span-12"><Collapsible open remember="flow-pulse" title="Order flow & futures pulse" icon={<Waves aria-hidden className="size-4 text-info"/>} aside={fresh&&s?.liveCall?.direction&&s?.flowPulse?.healthy?`live call: ${flowAlignment(s.liveCall.direction,s.flowPulse).label.toLowerCase()}`:'untested · recording'}><PanelBoundary name="Order flow"><FlowPulse s={s} fresh={fresh}/></PanelBoundary></Collapsible></div>
        </div></div>
      </div>
      <Collapsible remember="recent-rounds" title="Recent rounds" icon={<History aria-hidden className="size-4 text-info"/>} aside={s?.calibration?.roundTrends?.totals?.live300?.n?`5:00 call ${Math.round(s.calibration.roundTrends.totals.live300.rate*100)}% right`:'calls & results'}><RecentRounds s={s}/></Collapsible>
      <div className={cn('grid gap-4',s?.config?.showMakerIdeas?'lg:grid-cols-3':'lg:grid-cols-2')}>
        <Collapsible remember="session" title="Session & guardrails" icon={<ShieldCheck aria-hidden className="size-4 text-info"/>} aside={<span className="num">{signedDollars(s?.guards?.pnl)}</span>}><Session s={s}/></Collapsible>
        {s?.config?.showMakerIdeas?<Collapsible open title="Resting-bid ideas" icon={<Layers aria-hidden className="size-4 text-info"/>} aside={`${fresh?s?.evaluation?.makers?.length??0:0} now`}><MakerIdeas s={s} fresh={fresh}/></Collapsible>:null}
        <Collapsible remember="feeds" title="Feeds & latency" icon={<Activity aria-hidden className="size-4 text-info"/>} aside={s?.quality?.level}><Feeds s={s}/></Collapsible>
      </div>
      <Collapsible title="Settings & alerts" icon={<SlidersHorizontal aria-hidden className="size-4 text-info"/>} aside="thresholds, sizing, guardrails">
        {s?.config?<Settings config={s.config}/>:<p className="text-muted">Waiting for engine</p>}
      </Collapsible>
      <Collapsible title="Sound alerts" icon={<BellRing aria-hidden className="size-4 text-info"/>} aside={sound.prefs.enabled?(sound.ready?'on':'click page to arm'):'muted'}><SoundPanel {...sound}/></Collapsible>
      <footer className="flex flex-wrap justify-between gap-3 pt-2 text-xs text-faint"><span>Next: <span className="num">{s?.next?.ticker??'discovering'}</span> · journal stays in ./data/advisor.db · orders disabled · {finalMinuteEvidence(s?.backtest??null).text}{s?.backtestRefresh?.running?' · refreshing the backtest now':s?.backtest?.generated?` · backtest refreshed ${new Date(s.backtest.generated).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`:''}</span><a className="underline-offset-4 hover:text-fg hover:underline" href="/api/engine/export/signals">Export signals CSV</a></footer>
    </main>
    {s?.guards?.dailyLocked?<div role="dialog" aria-modal="true" aria-labelledby="lock-title" className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-5 backdrop-blur"><Card className="max-w-md space-y-5 border-no/40">
      <div className="label text-no">Daily discipline lock</div><h1 id="lock-title" className="font-display text-7xl font-bold text-no">LOCKED</h1>
      <p className="text-fg/90">Daily loss limit reached. Signals stay suppressed for the rest of the local day.</p><p className="text-sm text-muted">Override requires typing “I accept the risk”. This action is logged.</p>
      <label className="block space-y-2"><span className="label">Risk acknowledgement</span><Input value={override} onChange={e=>setOverride(e.target.value)} autoComplete="off"/></label>
      <Button disabled={override!=='I accept the risk'} onClick={unlock}>Override daily lock</Button><p role="alert" className="text-sm text-no">{error}</p></Card></div>:null}
  </>;
}
