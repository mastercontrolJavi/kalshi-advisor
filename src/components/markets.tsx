'use client';
import {Wallet,Info} from 'lucide-react';
import {useLive} from './use-live';
import {useSoundAlerts} from './use-sound-alerts';
import {SoundToggle} from './sound-panel';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Pill,Stat,Heading} from './panels';
import {PositionCardView} from './position-card';
import {MarketsNav,useMarketsFilter,FILTERS} from './markets-nav';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,ago} from './format';
/** Markets: every open Kalshi position outside the two Bitcoin series, from the separate markets process. */
export default function Markets(){
  const m=useLive('/markets-ws'),st=m.fresh?m.state:null,sound=useSoundAlerts(null,false,'markets',{state:m.state,fresh:m.fresh});
  const [filter,setFilter]=useMarketsFilter();
  const all:any[]=st?.positions??[],shown=filter==='all'?all:all.filter(p=>p.group===filter),now=st?.time??Date.now(),s=st?.summary;
  const counts=Object.fromEntries(FILTERS.map(([k])=>[k,k==='all'?all.length:all.filter(p=>p.group===k).length]));
  const synced=st?.synced?.positions?`synced ${ago(Math.max(0,now-st.synced.positions))} ago`:'not synced yet';
  const urgent=shown.some(p=>p.notice);
  return <>
    <div aria-hidden className="ambient" data-tone={!m.fresh?'warn':'none'}/>
    <SiteHeader current="/markets">
      <SoundToggle prefs={sound.prefs} setPrefs={sound.setPrefs} ready={sound.ready}/>
      <Pill tone={m.fresh?'yes':'warn'}><span className={m.fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{m.fresh?'Live':m.connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      <MarketsNav current="positions" filter={filter} setFilter={setFilter} counts={st?counts:undefined}/>
      {!st?<Card className="space-y-1"><p className="text-sm">Markets engine unavailable.</p><p className="text-sm text-muted">{m.connected?'Waiting for its first update.':'It starts with the app; this page reconnects on its own.'} The Bitcoin pages are not affected.</p></Card>:<>
      {st.status==='no-credentials'?<Card><p className="text-sm">Kalshi credentials unavailable, so positions cannot be read. Add the API key in .env.local.</p></Card>:null}
      <Card className="rise grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="At risk" sub={`${s.count} position${s.count===1?'':'s'} · cost incl. fees`}>{dollars(s.atRisk)}</Stat>
        <Stat label="If sold now" tone={s.sellAll>0?'yes':s.sellAll<0?'no':'neutral'} sub="P&L at the bids">{signedDollars(s.sellAll)}</Stat>
        <Stat label="If held" sub="value at market odds">{dollars(s.holdAll)}</Stat>
        <Stat label="Realized today" tone={s.realizedToday>0?'yes':s.realizedToday<0?'no':'neutral'} sub="outside Bitcoin">{signedDollars(s.realizedToday)}</Stat>
      </Card>
      {shown.length?<Card className={cn('rise',urgent?'border-warn/50':'border-info/30')}><Heading icon={<Wallet aria-hidden className="size-4 text-info"/>} title="Your other positions" aside={synced}/>
        <div className="mt-4">{shown.map(c=><PositionCardView key={c.ticker} c={c} now={now}/>)}</div></Card>
      :<Card className="flex min-h-14 flex-wrap items-center gap-3 py-3"><Wallet aria-hidden className="size-4 text-faint"/><span className="label">Your other positions</span><span className="ml-auto text-sm text-muted">{filter==='all'?'No open positions outside Bitcoin':'None in this category'} <span className="text-xs text-faint">· {synced}</span></span></Card>}
      {st.bitcoin?<p className="text-sm text-muted">You also hold {st.bitcoin} Bitcoin position{st.bitcoin===1?'':'s'}; see the <a className="text-info hover:underline" href="/">15-min</a> and <a className="text-info hover:underline" href="/hourly">Hourly</a> pages.</p>:null}
      {st.error?<p className="text-xs text-warn">Kalshi: {st.error}</p>:null}
      {st.sources?.length?<p className="text-xs text-muted">Outside prices: {st.sources.map((x:any,i:number)=><span key={x.name}>{i?' · ':''}{x.name} <span className={x.ok?'text-yes':x.detail==='no key'?'text-muted':'text-warn'}>{x.ok?'✓':'—'}</span> {x.error?`error: ${x.error}`:x.updated?`updated ${ago(Math.max(0,now-x.updated))} ago`:''}{x.detail?`${x.updated||x.error?' · ':''}${x.detail==='no key'?'no key (add ODDS_API_KEY to .env.local)':x.detail}`:''}</span>)}</p>:null}
      <Card className="flex items-start gap-3 text-xs text-muted"><Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info"/><span>Hold value is what the position pays at today&apos;s odds: an outside price (sportsbook consensus or Polymarket) when it was matched automatically or you confirmed it, otherwise Kalshi&apos;s YES mid; for a combo, its legs multiplied, which assumes they are independent. Selling pays the bid minus Kalshi&apos;s fee, so at Kalshi&apos;s own odds holding usually looks better; SELL BEATS HOLD appears when the bid beats what an outside source says the position is worth. Kalshi prices refresh every 5 s; outside prices every 5 min (every minute during a game you hold). These are numbers, not recommendations.</span></Card>
      </>}
    </main>
  </>;
}
