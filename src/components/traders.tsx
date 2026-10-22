'use client';
import {useCallback,useEffect,useMemo,useState} from 'react';
import {Trophy,Users,ExternalLink,Layers,Info,Plus,Check,Copy} from 'lucide-react';
import {useLive} from './use-live';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Pill,Empty,Heading,Collapsible,type Tone} from './panels';
import {groupOf,copyState} from './markets-sharps';
import {cn} from '@/lib/utils';
import {cents,pct,dollars,signedDollars,signedCents,ago} from './format';
import {useEntrance,useFlash} from './motion';
/**
 * Top traders (2026-10-22, user: "see what the top bettors hold and copy them, sports, crypto, combos, so I can make
 * money"). What Falcon-ranked Polymarket wallets hold now, tied to Kalshi markets, with the record of copying them: one
 * result per game, wins against what Kalshi's prices implied. Copies go to the paper account first (real Kalshi book and
 * fee); "Open on Kalshi" is there for a real trade, which the app never places itself. Kalshi publishes no other
 * traders' positions, so the wallets are Polymarket's.
 */
const SPORTS:[RegExp,string][]=[[/^(nfl|cfb)-/,'Football'],[/^(nba|wnba|cbb)-/,'Basketball'],[/^mlb-/,'Baseball'],[/^nhl-/,'Hockey'],[/^(atp|wta)-/,'Tennis'],
  [/^(epl|lal|sea|bun|fl1|ucl|uel|mls)-/,'Soccer'],[/^ufc-/,'MMA'],[/^(f1|nascar)-/,'Motorsport'],[/^pga-/,'Golf'],[/^(lol|cs2|val|dota)-/,'Esports']];
const kindOf=(b:any)=>{for(const [re,l] of SPORTS)if(re.test(b.eventSlug??''))return l;const g=groupOf(b);return g==='commodities'?'Crypto & commodities':g==='politics'?'Politics & world':'Sports';};
const GROUP:Record<string,string>={all:'All categories',sports:'Sports',politics:'Politics & econ',commodities:'Crypto & commodities',combos:'Combos'};
const price=(v:number|null|undefined)=>v!=null&&v<.01?cents(v,2):cents(v,0);
const short=(a:string)=>`${a.slice(0,6)}…${a.slice(-4)}`;
const PROOF=100;
async function post(path:string,body:unknown){
  const r=await fetch(`/api/engine/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error??`Request failed (HTTP ${r.status})`);return d;
}
type Idea={b:any;l:any;ask:number|null;state:{tone:Tone;text:string}};

export default function Traders(){
  const engine=useLive(),sim=engine.state?.sim,account=sim?.account??null,[r,setR]=useState<any>(null),[error,setError]=useState(''),[report,setReport]=useState<any>(null);
  const load=useCallback(async()=>{try{const res=await fetch('/api/markets/sharps',{cache:'no-store'});if(!res.ok)throw new Error(`HTTP ${res.status}`);setR(await res.json());setError('');}catch(e){setError((e as Error).message);}},[]);
  // Positions refresh every 10 min on the server; ask once a minute, like Markets → Sharps.
  useEffect(()=>{void load();const t=setInterval(()=>void load(),60000);return()=>clearInterval(t);},[load]);
  useEffect(()=>{let stop=false;fetch('/api/engine/sim/report',{cache:'no-store'}).then(x=>x.ok?x.json():null).then(d=>{if(!stop)setReport(d);}).catch(()=>{});return()=>{stop=true;};},[sim?.version]);
  const [combo,setCombo]=useState<string[]>([]),entrance=useEntrance<HTMLElement>();
  const ideas=useMemo<Idea[]>(()=>(r?.bets??[]).flatMap((b:any)=>(b.links??[]).map((l:any)=>({b,l,ask:l.side==='yes'?l.yesAsk:l.noAsk,state:copyState(b,l)}))),[r]);
  const ready=ideas.filter(i=>i.state.tone==='yes'),watching=ideas.filter(i=>i.state.tone!=='yes'),unmatched=(r?.bets??[]).filter((b:any)=>!b.links?.length);
  const chosen=ready.filter(i=>combo.includes(i.l.ticker+i.l.side));
  const toggle=(i:Idea)=>{const k=i.l.ticker+i.l.side;setCombo(c=>c.includes(k)?c.filter(x=>x!==k):[...c,k].slice(-6));};
  const copies=(report?.coach?.reviews??[]).filter((x:any)=>x.source==='copy');
  return <>
    <div aria-hidden className="ambient" data-tone="none"/>
    <SiteHeader current="/traders">
      <Pill tone={engine.fresh?'yes':'warn'}><span className={engine.fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{engine.fresh?'Live':engine.connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main ref={entrance} className="mx-auto max-w-[1600px] space-y-4 px-4 pt-4 pb-16 sm:px-6 3xl:max-w-[2400px] 4xl:max-w-[3200px]">
      {error?<p role="status" className="text-sm text-warn">Top traders unavailable: {error}. The markets process may be off; this retries every minute.</p>:null}
      <RecordCard copy={r?.copy} updated={r?.updated} positions={r?.counts?.positions}/>
      {!r?<Empty>{error?'Waiting for the markets process.':'Loading what the top wallets hold…'}</Empty>:<>
        <section aria-labelledby="copy-now" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="copy-now" className="font-display text-2xl font-semibold">Copy now</h2>
            <span className="text-sm text-muted">{ready.length?`${ready.length} bet${ready.length===1?'':'s'} meet the copy rule: 3+ wallets, $3,000+, little against, Kalshi no more than 3¢ above their entry`:'Nothing meets the copy rule right now. Bets still forming are under Watching.'}</span></div>
          {ready.length?<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">{ready.map(i=><IdeaCard key={i.l.ticker+i.l.side} i={i} account={account} equity={sim?.equity??0} inCombo={combo.includes(i.l.ticker+i.l.side)} toggle={()=>toggle(i)}/>)}</div>
            :<Empty>When three or more ranked wallets back the same bet with $3,000+ and Kalshi is still near their price, it appears here.</Empty>}
        </section>
        {chosen.length>=2?<ComboCard legs={chosen} clear={()=>setCombo([])}/>:chosen.length===1?<p className="text-sm text-muted">Add one more bet to see a combo estimate.</p>:null}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Collapsible open remember="traders-watching" title="Watching" icon={<Users aria-hidden className="size-4 text-info"/>} aside={`${watching.length} on Kalshi · ${unmatched.length} not on Kalshi`}>
            {watching.length?<ul className="divide-y divide-line/70">{watching.map(i=><li key={i.l.ticker+i.l.side} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
              <div className="min-w-0"><div className="font-medium">{i.b.outcome} <span className="text-sm font-normal text-muted">· {kindOf(i.b)}</span></div><div className="truncate text-xs text-muted">{i.b.title}</div></div>
              <div className="text-right text-sm"><span className="num">{i.b.wallets} wallets · {dollars(i.b.value,0)}</span><div className={cn('text-xs',i.state.tone==='warn'?'text-warn':'text-faint')}>{i.state.text}</div></div></li>)}</ul>
              :<Empty>No other agreed bets tied to Kalshi right now.</Empty>}
          </Collapsible>
          <Collapsible open remember="traders-copies" title="Your paper copies" icon={<Copy aria-hidden className="size-4 text-info"/>} aside={copies.length?`${copies.filter((x:any)=>x.pnl!=null).length} settled · ${signedDollars(copies.reduce((s:number,x:any)=>s+(x.pnl??0),0))}`:'none yet'}>
            {copies.length?<ul className="divide-y divide-line/70">{copies.slice(0,12).map((x:any)=><li key={x.ticker} className="flex items-baseline justify-between gap-3 py-2.5">
              <div className="min-w-0"><div className="truncate font-medium">{x.title??x.ticker}</div><div className="text-xs text-muted">{x.side.toUpperCase()} at {price(x.entry.price)} · {x.group?GROUP[x.group]??x.group:'copy'}</div></div>
              <div className="text-right"><div className={cn('num',x.pnl>0?'text-yes':x.pnl<0?'text-no':'text-muted')}>{x.pnl==null?'open':signedDollars(x.pnl)}</div>{x.result?<div className="text-xs text-muted">settled {x.result.toUpperCase()}</div>:null}</div></li>)}</ul>
              :<Empty>{account?'Copy a bet above and it is tracked here until Kalshi settles it.':<>Start a paper account on the <a className="text-info hover:underline" href="/paper">Paper</a> page, then copy bets here to test them for free.</>}</Empty>}
          </Collapsible>
        </div>
        <Collapsible open remember="traders-board" title="Leaderboard" icon={<Trophy aria-hidden className="size-4 text-info"/>} aside={`${r.counts?.wallets??0} Falcon-ranked · ${r.counts?.crypto??0} crypto leaders`}>
          {r.wallets?.length?<div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Trader','Tier','Score','Return (15 d)','Win rate','Trades','Profit','Trend'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
            <tbody>{r.wallets.map((w:any)=><tr key={w.address} className="border-t border-line/70"><th scope="row" className="py-2 pr-3 text-left font-normal"><a href={`https://polymarket.com/profile/${w.address}`} target="_blank" rel="noreferrer" className="num text-info hover:underline">{w.name??short(w.address)}</a></th>
              <td className="pr-3 text-muted">{w.tier??'—'}</td><td className="num pr-3">{w.score!=null?w.score.toFixed(1):'—'}</td><td className="num pr-3">{w.roi!=null?pct(w.roi,1):'—'}</td><td className="num pr-3">{w.winRate!=null?pct(w.winRate,0):'—'}</td>
              <td className="num pr-3">{w.trades??'—'}</td><td className={cn('num pr-3',w.pnl>0?'text-yes':'')}>{w.pnl!=null?dollars(w.pnl,0):'—'}</td><td className="text-muted">{w.trajectory??'—'}</td></tr>)}</tbody></table></div>
            :<Empty>The ranking loads about a minute after the markets process starts.</Empty>}
        </Collapsible>
        <Card className="flex items-start gap-3 bg-none bg-surface/55 text-sm text-muted shadow-none"><Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info"/><span>Wallets are ranked by Falcon (Polymarket Analytics) every 6 hours, with bots, wash traders and lucky streaks filtered out; their positions come from Polymarket&apos;s public data every 10 minutes. Kalshi does not publish other traders&apos; positions, so there is no Kalshi leaderboard to copy. A copy is a paper trade at Kalshi&apos;s live price and fee; nothing here places a real order.</span></Card>
      </>}
    </main>
  </>;
}

/** The record of copying, told plainly, with the distance to the proof bar. */
function RecordCard({copy,updated,positions}:{copy:any[]|undefined;updated:number|null|undefined;positions:number|undefined}){
  const all=copy?.find(x=>x.group==='all'),groups=(copy??[]).filter(x=>x.group!=='all');
  return <Card className="rise">
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Copy the wallets that win</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-fg/90">{all?<>Copying the top Polymarket wallets on Kalshi has won <b className="num">{all.wins}</b> of <b className="num">{all.n}</b> games where Kalshi&apos;s own prices implied <span className="num">{all.implied.toFixed(0)}</span>: <b className={cn('num',all.mean>0?'text-yes':'text-no')}>{signedCents(all.mean)}</b> a contract after fees, likely between <span className="num">{signedCents(all.low)}</span> and <span className="num">{signedCents(all.high)}</span>.</>:'No copy has settled yet: the record starts with the first settled game.'}</p>
        {all?<div className="mt-4 max-w-xl"><div className="flex justify-between text-xs text-muted"><span>{all.proven?'Proven':`${all.n} of ${PROOF} games to proof`}</span><span>first half {signedCents(all.first)} · second half {signedCents(all.second)}</span></div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2"><div className={cn('bar-fill h-full rounded-full',all.proven?'bg-yes':'bg-info')} style={{width:`${Math.min(100,all.n/PROOF*100)}%`}}/></div>
          <p className="mt-2 text-xs text-faint">One result per game. Proof needs {PROOF} games, a range above zero and both halves positive; until then a good run can still be luck.</p></div>:null}
      </div>
      <div className="min-w-0"><div className="text-sm font-semibold text-muted">By category</div>
        {groups.length?<ul className="mt-2 divide-y divide-line/70">{groups.map(g=><li key={g.group} className="flex items-baseline justify-between gap-3 py-2"><span>{GROUP[g.group]??g.group}</span>
          <span className="text-right text-sm"><span className={cn('num font-semibold',g.mean>0?'text-yes':'text-no')}>{signedCents(g.mean)}</span> <span className="text-muted">· {g.wins}/{g.n} won, {g.implied.toFixed(0)} implied</span></span></li>)}</ul>
          :<p className="mt-2 text-sm text-muted">Categories appear as their copies settle.</p>}
        <p className="mt-3 text-xs text-faint">{updated?`${(positions??0).toLocaleString()} open positions read ${ago(Math.max(0,Date.now()-updated))} ago`:'The first read runs about a minute after the markets process starts.'}</p></div>
    </div>
  </Card>;
}

function IdeaCard({i,account,equity,inCombo,toggle}:{i:Idea;account:any;equity:number;inCombo:boolean;toggle:()=>void}){
  const {b,l,ask}=i,[amount,setAmount]=useState(String(Math.max(5,Math.round((equity||500)*.02)))),[busy,setBusy]=useState(false),[status,setStatus]=useState<{ok:boolean;text:string}|null>(null);
  const flash=useFlash<HTMLDivElement>(status?.ok?status.text:null),edgeVsEntry=b.avgEntry!=null&&ask!=null?ask-b.avgEntry:null;
  async function copy(){setBusy(true);setStatus(null);try{const d=await post('sim/order',{ticker:l.ticker,side:l.side,action:'buy',dollars:Number(amount),
    copy:{cond:b.cond,outcome:b.outcome,title:b.title,group:groupOf(b),wallets:b.wallets,value:b.value,avgEntry:b.avgEntry}});setStatus({ok:true,text:d.message});}catch(e){setStatus({ok:false,text:(e as Error).message});}finally{setBusy(false);}}
  return <Card ref={flash} className={cn('rise flex flex-col gap-3 p-4',inCombo&&'border-info/60')}>
    <div className="flex items-center justify-between gap-2"><Pill tone="neutral">{kindOf(b)}</Pill><span className="text-xs text-muted">{b.endDate?`ends ${new Date(b.endDate).toLocaleDateString([],{month:'short',day:'numeric'})}`:''}</span></div>
    <div><div className="font-display text-xl font-semibold leading-tight">{b.outcome}</div><div className="mt-1 line-clamp-2 text-sm text-muted">{l.title}</div></div>
    <dl className="grid grid-cols-3 gap-2 text-sm"><div><dt className="text-xs text-muted">Wallets</dt><dd className="num font-semibold">{b.wallets}</dd></div><div><dt className="text-xs text-muted">They hold</dt><dd className="num font-semibold">{dollars(b.value,0)}</dd></div>
      <div><dt className="text-xs text-muted">Against</dt><dd className="num font-semibold">{b.against.wallets?dollars(b.against.value,0):'none'}</dd></div></dl>
    <p className="text-sm">Kalshi <b>{l.side.toUpperCase()}</b> at <span className="num font-semibold">{price(ask)}</span>{b.avgEntry!=null?<span className="text-muted"> · they paid {price(b.avgEntry)}{edgeVsEntry!=null&&edgeVsEntry<=0?', you would pay less':''}</span>:null}</p>
    <div className="mt-auto flex gap-2"><label className="sr-only" htmlFor={`amt-${l.ticker}-${l.side}`}>Paper amount in dollars</label>
      <Input id={`amt-${l.ticker}-${l.side}`} className="w-24" type="number" inputMode="decimal" min={1} step="any" value={amount} onChange={e=>setAmount(e.target.value)}/>
      <Button className="flex-1" disabled={busy||!account||!(Number(amount)>0)} onClick={()=>void copy()}>{busy?'Copying…':account?'Copy to paper':'Start a paper account first'}</Button></div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"><a href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-info hover:underline">Open on Kalshi<ExternalLink aria-hidden className="size-3.5"/></a>
      <a href={b.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-fg">Polymarket<ExternalLink aria-hidden className="size-3.5"/></a>
      <button type="button" aria-pressed={inCombo} onClick={toggle} className={cn('ml-auto inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs transition-colors',inCombo?'bg-info/15 text-info':'text-muted hover:text-fg')}>{inCombo?<Check aria-hidden className="size-3.5"/>:<Plus aria-hidden className="size-3.5"/>}{inCombo?'In combo':'Add to combo'}</button></div>
    <p role="status" className={cn('min-h-4 text-xs',status?(status.ok?'text-yes':'text-no'):'')}>{status?.text??''}</p>
  </Card>;
}

/** An estimate of a combo built from copy-ready legs: what Kalshi's prices say about all of them winning together. */
function ComboCard({legs,clear}:{legs:Idea[];clear:()=>void}){
  const [stake,setStake]=useState('10'),asks=legs.map(l=>l.ask).filter((x):x is number=>x!=null&&x>0);
  const p=asks.length===legs.length?asks.reduce((a,b)=>a*b,1):null,payout=p?Number(stake)/p:null;
  const games=new Map<string,number>();for(const l of legs){const k=String(l.l.ticker).split('-').slice(1).join('-');games.set(k,(games.get(k)??0)+1);}const sameGame=[...games.values()].some(n=>n>1);
  return <Card className="rise border-info/40">
    <Heading icon={<Layers aria-hidden className="size-4 text-info"/>} title="Combo estimate" aside={<button type="button" onClick={clear} className="cursor-pointer text-xs text-muted hover:text-fg">Clear</button>}/>
    <ul className="mt-3 space-y-1.5 text-sm">{legs.map(l=><li key={l.l.ticker+l.l.side} className="flex justify-between gap-3"><span className="min-w-0 truncate">{l.b.outcome} <span className="text-muted">· {kindOf(l.b)}</span></span><span className="num shrink-0">{price(l.ask)}</span></li>)}</ul>
    <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3"><div><div className="label">All legs win</div><div className="num font-display text-3xl font-bold">{p?pct(p,1):'—'}</div><div className="text-xs text-muted">at Kalshi&apos;s prices</div></div>
      <label className="block w-28 space-y-1" htmlFor="combo-stake"><span className="label">Stake ($)</span><Input id="combo-stake" type="number" inputMode="decimal" min={1} value={stake} onChange={e=>setStake(e.target.value)}/></label>
      <div><div className="label">Pays if all win</div><div className="num font-display text-3xl font-bold text-yes">{payout?dollars(payout):'—'}</div><div className="text-xs text-muted">before Kalshi&apos;s combo margin</div></div></div>
    {sameGame?<p className="mt-3 text-sm text-warn">Two legs are from the same game: they win or lose together more often than the prices assume.</p>:null}
    <p className="mt-3 max-w-3xl text-xs text-faint">An estimate only. Kalshi prices combos itself, usually a little worse than the legs multiplied, and every leg&apos;s margin compounds: a combo pays more but wins less often. It only beats single bets when each leg has an edge on its own, so check each leg&apos;s record first. Build the real combo on Kalshi.</p>
  </Card>;
}
