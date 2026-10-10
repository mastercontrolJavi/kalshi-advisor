'use client';
import {useCallback,useEffect,useState} from 'react';
import {Info,Radar} from 'lucide-react';
import {useLive} from './use-live';
import {useSoundAlerts} from './use-sound-alerts';
import {SoundToggle} from './sound-panel';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Pill,Empty,Heading,type Tone} from './panels';
import {MarketsNav,useMarketsFilter,FILTERS} from './markets-nav';
import {FLAG_LABEL,evidenceText} from './flag-labels';
import {cn} from '@/lib/utils';
import {cents,pct,ago} from './format';
const REFRESH_MS=60000;
const groupLabel:Record<string,string>={sports:'Sports',combos:'Combos',politics:'Politics & econ',commodities:'Commodities & crypto'};
const flagTone=(t:string):Tone=>t.startsWith('ref-gap')?'yes':t.startsWith('move')?'warn':'neutral';
const price=(v:number|null|undefined)=>v!=null&&v<.01?cents(v,2):cents(v);
const money=(v:number)=>v>=1e6?`$${(v/1e6).toFixed(1)}M`:v>=1e3?`$${(v/1e3).toFixed(0)}k`:`$${Math.round(v)}`;
function due(t:number|null,now:number){if(!t)return '—';const s=Math.round((t-now)/1000);if(s<=0)return 'due';const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${m}m`;}
/** What the flag says, in a few words: the gap after fees, the move, or the band. */
function flagDetail(f:any){
  if(f.type.startsWith('ref-gap'))return `${cents(f.edge)} after fees · buy ${f.side.toUpperCase()} at ${price(f.price)}`;
  if(f.type.startsWith('move'))return `moved ${cents(f.edge,0)} in 1 h · ${f.side.toUpperCase()} at ${price(f.price)}`;
  return `buying ${f.side.toUpperCase()} at this price returned +${(f.edge*100).toFixed(1)}% per $1 after fees · ${f.side.toUpperCase()} at ${price(f.price)}`;
}
/** Markets → Scanner: liquid Kalshi markets that stand out, each reason paper-traded and scored as markets settle. */
export default function MarketsScan(){
  const m=useLive('/markets-ws'),sound=useSoundAlerts(null,false,'markets',{state:m.state,fresh:m.fresh});
  const [filter,setFilter]=useMarketsFilter(),[r,setR]=useState<any>(null),[error,setError]=useState('');
  const load=useCallback(async()=>{try{const res=await fetch('/api/markets/scan',{cache:'no-store'});if(!res.ok)throw new Error(`HTTP ${res.status}`);setR(await res.json());setError('');}catch(e){setError((e as Error).message);}},[]);
  // The scanner sweeps every 5 min; the page asks once a minute, like Analytics and Record.
  useEffect(()=>{void load();const t=setInterval(()=>void load(),REFRESH_MS);return()=>clearInterval(t);},[load]);
  const rows:any[]=r?.rows??[],shown=filter==='all'?rows:rows.filter(x=>x.group===filter),now=Date.now();
  const counts=Object.fromEntries(FILTERS.map(([k])=>[k,k==='all'?rows.length:rows.filter(x=>x.group===k).length]));
  return <>
    <div aria-hidden className="ambient" data-tone={!m.fresh?'warn':'none'}/>
    <SiteHeader current="/markets">
      <SoundToggle prefs={sound.prefs} setPrefs={sound.setPrefs} ready={sound.ready}/>
      <Pill tone={m.fresh?'yes':'warn'}><span className={m.fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{m.fresh?'Live':m.connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      <MarketsNav current="scan" filter={filter} setFilter={setFilter} counts={r?counts:undefined}/>
      {error?<p className="text-xs text-warn">Could not load the scanner: {error}</p>:null}
      {!r?<Empty>{error?'The markets engine is unavailable; this page retries every minute.':'Loading the scanner…'}</Empty>:<>
      <Card className="rise"><h2 className="font-semibold">Markets that stand out</h2>
        <p className="mt-1 max-w-4xl text-sm text-muted">Kalshi markets with at least $1,000 traded in 24 h, checked every 5 minutes for three reasons: an outside price above the ask after fees, a move of 10¢ or more in an hour, or a price band whose settled history lost (or won) after fees. Every flag is a one-contract paper trade scored when its market settles. A flag type stays <span className="text-fg">unproven</span> until 100 have settled with a 95% range above zero and both halves positive. These are measured hints, not recommendations.</p>
        <p className="mt-2 text-xs text-muted">{r.updated?`${r.count} liquid markets checked ${ago(Math.max(0,now-r.updated))} ago`:'The first scan runs about 2 minutes after the app starts.'}{r.error?<span className="text-warn"> · last scan failed: {r.error}</span>:null}</p></Card>
      {shown.length?<Card className="rise"><Heading icon={<Radar aria-hidden className="size-4 text-info"/>} title="Flagged now" aside={`${shown.length} market${shown.length===1?'':'s'} · flags from the last 6 h`}/>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Why','Market','Bid / ask','Spread','24 h traded','Result in','Outside'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
          <tbody>{shown.map(x=><tr key={x.ticker} className="border-t border-line align-top">
            <td className="py-2 pr-3"><ul className="space-y-1.5">{x.flags.map((f:any)=><li key={f.type}><Pill tone={flagTone(f.type)}>{FLAG_LABEL[f.type]??f.type}</Pill><div className="mt-0.5 text-xs">{flagDetail(f)}</div><div className={cn('text-xs',f.evidence?.proven?'text-yes':'text-faint')}>{evidenceText(f.evidence)}</div></li>)}</ul></td>
            <th scope="row" className="py-2 pr-3 text-left font-normal"><div className="font-medium">{x.yesLabel}</div><div className="text-xs text-muted">{x.title} · {groupLabel[x.group]??x.group}</div><a href={x.url} target="_blank" rel="noreferrer" className="text-xs text-info hover:underline">Open on Kalshi</a></th>
            <td className="num py-2 pr-3">{price(x.yesBid)} / {price(x.yesAsk)}</td><td className="num py-2 pr-3">{x.spread!=null?cents(x.spread):'—'}</td><td className="num py-2 pr-3">{money(x.dollarVolume)}</td><td className="num py-2 pr-3">{due(x.closeTime,now)}</td>
            <td className="num py-2">{x.ref?<>{pct(x.ref.prob,1)}<div className="text-xs text-muted">{x.ref.source==='sportsbooks'?'Sportsbooks':'Polymarket'}{x.ref.gap!=null?` · ${x.ref.gap>=0?'+':'−'}${Math.abs(x.ref.gap*100).toFixed(1)} pts vs mid`:''}</div></>:'—'}</td></tr>)}</tbody></table></div></Card>
      :<Empty>{r.updated?`Nothing stands out${filter==='all'?'':' in this category'} right now. ${r.count} liquid markets were checked.`:'The first scan runs about 2 minutes after the app starts.'}</Empty>}
      <Card className="flex items-start gap-3 text-xs text-muted"><Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info"/><span>Coverage: the 20 most-traded series in each category plus every series you have traded, minus the two Bitcoin series and combos (combos never trade publicly). Outside prices are Polymarket sports matches; sportsbook prices are kept for your own positions to stay inside the free quota. 1-hour moves skip commodities and crypto, whose prices follow a spot price; price-band flags only appear when the result is due within 48 h. Paper results and their ranges are on the Record tab.</span></Card>
      </>}
    </main>
  </>;
}
