'use client';
import {useCallback,useEffect,useState} from 'react';
import {Info,Users,Bitcoin,Trophy} from 'lucide-react';
import {useLive} from './use-live';
import {useSoundAlerts} from './use-sound-alerts';
import {SoundToggle} from './sound-panel';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Button} from './ui/button';
import {Pill,Empty,Heading,type Tone} from './panels';
import {MarketsNav,useMarketsFilter,FILTERS} from './markets-nav';
import {FLAG_LABEL,evidenceText} from './flag-labels';
import {cn} from '@/lib/utils';
import {cents,pct,ago,dollars,mmss} from './format';
const REFRESH_MS=60000;
const ext={target:'_blank',rel:'noreferrer',className:'text-info hover:underline'};
const price=(v:number|null|undefined)=>v!=null&&v<.01?cents(v,2):cents(v);
const short=(a:string)=>`${a.slice(0,6)}…${a.slice(-4)}`;
const signed=(v:number)=>`${v>=0?'+':'−'}${dollars(Math.abs(v))}`;
export const SPORT=/^(nfl|cfb|cbb|nba|wnba|nhl|mlb|mls|epl|lal|sea|bun|fl1|ucl|uel|atp|wta|ufc|f1|nascar|pga|lol|cs2|val|dota)-/;
/** Category chip for a Polymarket bet: by its linked Kalshi market's place in the chips, else by its event slug. */
export const groupOf=(b:any)=>SPORT.test(b.eventSlug??'')?'sports':/bitcoin|ethereum|solana|btc|eth|xrp|crypto|oil|gold/i.test(b.title)?'commodities':'politics';
/** A copy flag can fire: 3+ wallets, $3,000+, little against, a trusted link, Kalshi's ask within 3¢ of their entry. */
export function copyState(b:any,l:any):{tone:Tone;text:string}{
  const ask=l.side==='yes'?l.yesAsk:l.noAsk;
  if(l.status==='suggested')return {tone:'neutral',text:'confirm the market to score copies'};
  if(b.wallets<3||b.value<3000)return {tone:'neutral',text:'needs 3+ wallets and $3,000'};
  if(b.against.value>.25*b.value)return {tone:'neutral',text:'sharps split on it'};
  if(ask==null)return {tone:'neutral',text:'no Kalshi ask'};
  if(b.avgEntry!=null&&ask>b.avgEntry+.03)return {tone:'warn',text:`Kalshi ${price(ask)} is above their ${price(b.avgEntry)} entry: chasing`};
  return {tone:'yes',text:`copy ${l.side.toUpperCase()} at ${price(ask)} or less · logged as a paper trade`};
}
function LinkCell({b,l,reload}:{b:any;l:any;reload:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const decide=async(status:'confirmed'|'rejected')=>{setBusy(true);setError('');try{const res=await fetch('/api/markets/sharp-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cond:b.cond,ticker:l.ticker,status})});if(!res.ok)throw new Error(`Could not save (HTTP ${res.status})`);reload();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const ask=l.side==='yes'?l.yesAsk:l.noAsk,state=copyState(b,l);
  return <div className="space-y-1"><div><a href={l.url} {...ext}>{l.title}</a></div>
    <div className="text-xs text-muted">pays on Kalshi <span className="text-fg">{l.side.toUpperCase()}</span> · ask <span className="num text-fg">{price(ask)}</span> · {l.status==='auto'?'auto match':l.status==='confirmed'?'you confirmed':'possible match'}</div>
    {l.status==='suggested'?<div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={()=>void decide('confirmed')} aria-label={`Confirm “${l.title}” is the same bet as “${b.title}”`}>✓ Same market</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void decide('rejected')} aria-label={`“${l.title}” is not the same bet`}>✗ Not it</Button>{error?<span className="text-xs text-warn">{error}</span>:null}</div>:null}
    <div className={cn('text-xs',state.tone==='yes'?'text-yes':state.tone==='warn'?'text-warn':'text-faint')}>{state.text}</div></div>;
}
/** One Bitcoin-round rule scored per horizon: how often its side won, and buying that side at Kalshi's ask plus fee. */
function LeanTable({rows,columns}:{rows:any[];columns:string[]}){
  return <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[640px] text-sm"><thead className="text-left text-xs text-muted"><tr>{columns.map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
    <tbody>{rows.map((s:any)=><tr key={s.horizon} className="border-t border-line"><th scope="row" className="py-1.5 pr-3 text-left font-medium">{s.horizon/60} min left</th><td className="num pr-3">{s.calls??0}</td>
      <td className="num pr-3">{s.rate!=null?`${pct(s.rate,0)} (${pct(s.low,0)}–${pct(s.high,0)})`:'—'}</td><td className="num pr-3">{s.paper?.mean!=null?`${s.paper.mean>=0?'+':'−'}${Math.abs(s.paper.mean*100).toFixed(1)}¢`:'—'}{s.paper?.low!=null?<span className="text-xs text-muted"> ({(s.paper.low*100).toFixed(1)} to {(s.paper.high*100).toFixed(1)})</span>:null}</td>
      <td>{s.proven?<Pill tone="yes">proven</Pill>:<span className="text-xs text-faint">unproven · {s.paper?.n??0} scored</span>}</td></tr>)}</tbody></table></div>;
}
/** Markets → Sharps: what Polymarket's best-ranked traders hold, tied to Kalshi markets, and how copying them scores. */
export default function MarketsSharps(){
  const m=useLive('/markets-ws'),sound=useSoundAlerts(null,false,'markets',{state:m.state,fresh:m.fresh});
  const [filter,setFilter]=useMarketsFilter(),[r,setR]=useState<any>(null),[error,setError]=useState('');
  const load=useCallback(async()=>{try{const res=await fetch('/api/markets/sharps',{cache:'no-store'});if(!res.ok)throw new Error(`HTTP ${res.status}`);setR(await res.json());setError('');}catch(e){setError((e as Error).message);}},[]);
  // Positions refresh every 10 min on the server; the page asks once a minute, like Scanner and Record.
  useEffect(()=>{void load();const t=setInterval(()=>void load(),REFRESH_MS);return()=>clearInterval(t);},[load]);
  const bets:any[]=r?.bets??[],shown=filter==='all'?bets:bets.filter(b=>groupOf(b)===filter),now=Date.now(),btc=r?.btc,stats:any[]=r?.stats??[];
  const counts=Object.fromEntries(FILTERS.map(([k])=>[k,k==='all'?bets.length:bets.filter(b=>groupOf(b)===k).length]));
  const ev=(type:string)=>stats.find(s=>s.type===type&&s.group==='all')??null;
  return <>
    <div aria-hidden className="ambient" data-tone={!m.fresh?'warn':'none'}/>
    <SiteHeader current="/markets">
      <SoundToggle prefs={sound.prefs} setPrefs={sound.setPrefs} ready={sound.ready}/>
      <Pill tone={m.fresh?'yes':'warn'}><span className={m.fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{m.fresh?'Live':m.connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      <MarketsNav current="sharps" filter={filter} setFilter={setFilter} counts={r?counts:undefined}/>
      {error?<p className="text-xs text-warn">Could not load sharp money: {error}</p>:null}
      {!r?<Empty>{error?'The markets engine is unavailable; this page retries every minute.':'Loading sharp money…'}</Empty>:<>
      <Card className="rise"><h2 className="font-semibold">Who is betting what</h2>
        <p className="mt-1 max-w-4xl text-sm text-muted">The {r.counts.wallets} best Polymarket traders of the last 15 days by Falcon&apos;s ranking (bots, wash traders and lucky streaks filtered out), and what they hold now. Where 3 or more agree with $3,000 at stake and Kalshi sells the same bet within 3¢ of their price, the app logs a one-contract copy and scores it when the market settles. Copying stays <span className="text-fg">unproven</span> until 100 have settled with a 95% range above zero and both halves positive: a 15-day ranking still rewards luck, and their size can move the price after they buy.</p>
        <p className="mt-2 text-xs text-muted">{r.updated?`${r.counts.positions.toLocaleString()} open positions read ${ago(Math.max(0,now-r.updated))} ago`:'The first read runs about a minute after the app starts.'}{(r.sources??[]).map((x:any)=><span key={x.name}> · {x.name} <span className={x.ok?'text-yes':x.detail==='no key'?'text-muted':'text-warn'}>{x.ok?'✓':'—'}</span> {x.error?`error: ${x.error}`:x.detail==='no key'?'no key (add FALCON_API_KEY to .env.local)':x.detail}</span>)}</p>
        <p className="mt-2 text-xs"><span className="text-muted">Copy record:</span> {['sharp-yes','sharp-no'].map((t,i)=><span key={t}>{i?' · ':''}{FLAG_LABEL[t]} <span className={ev(t)?.proven?'text-yes':'text-faint'}>{evidenceText(ev(t))}</span></span>)}</p></Card>
      <Card className="rise"><Heading icon={<Bitcoin aria-hidden className="size-4 text-info"/>} title="Bitcoin 15-min round · sharp crypto traders" aside={btc?.slug?<a href={`https://polymarket.com/event/${btc.slug}`} {...ext}>Polymarket round</a>:'waiting for the round'}/>
        {btc?<><div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div><div className="label">Sharp money</div><div className={cn('num mt-1 text-3xl font-semibold',Math.abs(btc.sharpNet)<100?'text-muted':btc.sharpNet>0?'text-yes':'text-no')}>{Math.abs(btc.sharpNet)<100?'No lean':btc.sharpNet>0?'UP':'DOWN'} <span className="text-xl">{signed(btc.sharpNet)}</span></div><div className="text-xs text-muted">{btc.sharpWallets} wallet{btc.sharpWallets===1?'':'s'} · {btc.sharpTrades} trades</div></div>
          <div><div className="label">All traders</div><div className="num mt-1 text-xl">{signed(btc.allNet)} on Up</div><div className="text-xs text-muted">{btc.trades} trades</div></div>
          <div><div className="label">Polymarket Up</div><div className="num mt-1 text-xl">{pct(btc.upPrice,0)}</div><div className="text-xs text-muted">{mmss(btc.tau)} left · <span className="num">{btc.ticker}</span></div></div></div>
          {btc.error?<p className="mt-2 text-xs text-warn">{btc.error}</p>:null}
          <LeanTable rows={btc.stats} columns={['Recorded at','Rounds with a lean','Lean side won','Buy that side on Kalshi','Status']}/>
          {/* Moved here from the 15-minute dashboard (2026-10-28): none of these has shown an edge on Kalshi's price. */}
          <div className="label mt-5">Trend + sharps agree</div>
          <LeanTable rows={btc.stats.map((s:any)=>({horizon:s.horizon,...s.agree}))} columns={['Recorded at','Rounds they agreed','Agreed side won','Buy that side on Kalshi','Status']}/>
          <div className="label mt-5">Polymarket&apos;s price vs Kalshi&apos;s, 3¢+ apart</div>
          <LeanTable rows={btc.stats.map((s:any)=>({horizon:s.horizon,...s.pmGap}))} columns={['Recorded at','Rounds 3¢+ apart',"Polymarket's side won",'Buy that side on Kalshi','Status']}/>
          <p className="mt-2 text-xs text-faint">Polymarket&apos;s round settles on Chainlink&apos;s average over the whole 15 minutes; Kalshi&apos;s on the last 60 s. Related, not the same bet, so each rule is scored on Kalshi&apos;s result: did buying its side at Kalshi&apos;s ask (plus fee) pay? A lean needs $100+ of sharp money net on one side; trend + sharps needs the trend on the same side.</p></>
        :<p className="mt-3 text-sm text-muted">Waiting for the first read of the current round.</p>}</Card>
      {shown.length?<Card className="rise"><Heading icon={<Users aria-hidden className="size-4 text-info"/>} title="Where sharp traders agree" aside={`${shown.length} bet${shown.length===1?'':'s'} held by 2+ ranked wallets`}/>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[980px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Bet','Sharp wallets','Against','Their entry → now','On Kalshi'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
          <tbody>{shown.map(b=><tr key={b.cond+b.outcome} className="border-t border-line align-top">
            <th scope="row" className="max-w-[340px] py-2 pr-3 text-left font-normal"><div className="font-medium">{b.outcome}</div><div className="text-xs text-muted">{b.title}{b.endDate?` · ends ${b.endDate.slice(0,10)}`:''}</div><a href={b.url} {...ext} className="text-xs text-info hover:underline">Open on Polymarket</a></th>
            <td className="num py-2 pr-3">{b.wallets}<div className="text-xs text-muted">{dollars(b.value)}</div></td>
            <td className="num py-2 pr-3">{b.against.wallets?<>{b.against.wallets}<div className="text-xs text-muted">{dollars(b.against.value)}</div></>:<span className="text-faint">none</span>}</td>
            <td className="num py-2 pr-3">{price(b.avgEntry)} → {price(b.curPrice)}</td>
            <td className="py-2">{b.links.length?<div className="space-y-3">{b.links.map((l:any)=><LinkCell key={l.ticker} b={b} l={l} reload={()=>void load()}/>)}</div>:<span className="text-xs text-faint">no Kalshi market tied to it</span>}</td></tr>)}</tbody></table></div></Card>
      :<Empty>{r.updated?`No bet${filter==='all'?'':' in this category'} is held by two or more ranked traders right now.`:'The first read runs about a minute after the app starts.'}</Empty>}
      {r.wallets?.length?<Card className="rise"><Heading icon={<Trophy aria-hidden className="size-4 text-info"/>} title="Ranked traders" aside={`${r.counts.wallets} Falcon-ranked · ${r.counts.crypto} crypto leaders`}/>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[820px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Trader','Tier','Score','Return (15 d)','Win rate','Trades','Profit','Trend'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
          <tbody>{r.wallets.map((w:any)=><tr key={w.address} className="border-t border-line"><th scope="row" className="py-1.5 pr-3 text-left font-normal"><a href={`https://polymarket.com/profile/${w.address}`} {...ext} className="num text-info hover:underline">{w.name??short(w.address)}</a></th>
            <td className="pr-3 text-muted">{w.tier}</td><td className="num pr-3">{w.score!=null?w.score.toFixed(1):'—'}</td><td className="num pr-3">{w.roi!=null?pct(w.roi,1):'—'}</td><td className="num pr-3">{w.winRate!=null?pct(w.winRate,0):'—'}</td>
            <td className="num pr-3">{w.trades??'—'}</td><td className="num pr-3">{w.pnl!=null?dollars(w.pnl):'—'}</td><td className="text-muted">{w.trajectory??'—'}</td></tr>)}</tbody></table></div></Card>:null}
      <Card className="flex items-start gap-3 text-xs text-muted"><Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info"/><span>Sources: Falcon (Polymarket Analytics) ranks traders every 6 hours; their open positions come from Polymarket&apos;s public data every 10 minutes; the Bitcoin round&apos;s trades every 20 seconds. Sports bets tie to Kalshi games automatically through the same matching as outside prices. Other bets get a suggested Kalshi market by title, which you confirm: near-identical titles can mean the opposite bet. Copies are paper trades only; the Record tab lists their results with every other flag.</span></Card>
      </>}
    </main>
  </>;
}
