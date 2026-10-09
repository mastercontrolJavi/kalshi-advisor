import type {SoundName} from './sounds';
/** The slice of live state that alerts react to. Sounds fire on transitions only, never on the first snapshot. */
export interface AlertSnapshot {ticker:string|null;tau:number|null;entryAt:number;ideaKey:string|null;ideaSide:string|null;setupKey?:string|null;exits:Record<string,string>;pnl:number|null;day:string|null;liveDir:string|null;unreliable:boolean;locked:boolean;notices?:Record<string,string|null>}
/** `page` picks which market the sounds follow: the 15-minute round, or the current hour (KXBTCD) on /hourly. */
export function snapshot(s:any,fresh:boolean,page:'15m'|'hourly'='15m'):AlertSnapshot{
  const common={pnl:s?.guards?.pnl??null,day:s?.guards?.today??null,unreliable:!fresh||s?.quality?.level==='unreliable',locked:!!s?.guards?.locked};
  if(page==='hourly'){const h=fresh?s?.hourly:null,best=h?.ideas?.[0];
    return {...common,ticker:h?.event??null,tau:h?.event?h.tau:null,entryAt:s?.config?.sweetMaxSeconds??900,ideaKey:best?[best.ticker,best.side,best.price].join(':'):null,ideaSide:best?.side??null,setupKey:null,
      exits:Object.fromEntries((h?.exits??[]).map((e:any)=>[e.ticker,e.action])),notices:Object.fromEntries((h?.exits??[]).map((e:any)=>[e.ticker,e.notice?.kind??null])),liveDir:h?.up?.direction??null};}
  const idea=fresh?s?.evaluation?.idea:null;
  const setup=fresh?s?.tactics?.ideas?.[0]:null;
  return {ticker:s?.market?.ticker??null,tau:s?.market?s.tau:null,entryAt:s?.config?.sweetMaxSeconds??300,ideaKey:idea?[s.ticker,idea.side,idea.price].join(':'):null,ideaSide:idea?.side??null,setupKey:setup?[s.ticker,setup.kind,setup.side].join(':'):null,
    exits:Object.fromEntries((fresh?s?.exits??[]:[]).map((e:any)=>[e.ticker,e.action])),notices:Object.fromEntries((fresh?s?.exits??[]:[]).map((e:any)=>[e.ticker,e.notice?.kind??null])),pnl:s?.guards?.pnl??null,day:s?.guards?.today??null,
    liveDir:fresh?s?.liveCall?.direction??null:null,unreliable:!fresh||s?.quality?.level==='unreliable',locked:!!s?.guards?.locked};
}
// Most important first; the player spaces them out and caps how many play per update.
export const priority:SoundName[]=['cutLoss','takeProfit','sell','positionMove','comboDead','oneLeft','marketMove','legWon','lock','buyYes','buyNo','win','loss','warning','setup','hold','closingUp','closingDown','flipUp','flipDown','newWindow','entryWindow','finalMinute'];
export function detectEvents(prev:AlertSnapshot|null,next:AlertSnapshot):SoundName[]{
  if(!prev)return [];
  const out=new Set<SoundName>();
  if(next.ideaKey&&next.ideaKey!==prev.ideaKey)out.add(next.ideaSide==='yes'?'buyYes':'buyNo');
  if(next.setupKey&&next.setupKey!==prev.setupKey)out.add('setup');
  for(const [ticker,action] of Object.entries(next.exits)){const before=prev.exits[ticker];
    if(action!==before){if(action==='TAKE PROFIT')out.add('takeProfit');else if(action==='CUT LOSS')out.add('cutLoss');else if(action==='SELL NOW')out.add('sell');}
    if((action==='HOLD'&&(before===undefined||['SELL NOW','TAKE PROFIT','CUT LOSS'].includes(before)))||(action==='RIDE'&&before!=='RIDE'&&before!=='TAKE PROFIT'))out.add('hold');}
  if(prev.pnl!==null&&next.pnl!==null&&prev.day===next.day){const d=next.pnl-prev.pnl;if(d>.005)out.add('win');else if(d<-.005)out.add('loss');}
  const sameWindow=prev.ticker!==null&&prev.ticker===next.ticker;
  if(prev.ticker!==null&&next.ticker!==null&&next.ticker!==prev.ticker)out.add('newWindow');
  if(sameWindow&&prev.liveDir&&next.liveDir&&prev.liveDir!==next.liveDir)out.add(next.liveDir==='UP'?'flipUp':'flipDown');
  if(sameWindow&&prev.tau!==null&&next.tau!==null){if(prev.tau>next.entryAt&&next.tau<=next.entryAt)out.add('entryWindow');if(prev.tau>60&&next.tau<=60)out.add(next.liveDir==='UP'?'closingUp':next.liveDir==='DOWN'?'closingDown':'finalMinute');}
  if(!prev.unreliable&&next.unreliable)out.add('warning');
  if(!prev.locked&&next.locked)out.add('lock');
  // Hold-mode heads-up: a new or different notice on a position (not when it clears).
  for(const [ticker,kind] of Object.entries(next.notices??{}))if(kind&&kind!==(prev.notices?.[ticker]??null))out.add('positionMove');
  return priority.filter(n=>out.has(n));
}
const MARKET_SOUNDS:Record<string,SoundName>={dead:'comboDead','one-left':'oneLeft','leg-won':'legWon'};
/** Notice kind per held market from the markets process; empty when its state is not fresh (silence, not a change). */
export function marketsSnapshot(m:any,fresh:boolean):Record<string,string|null>{return fresh&&m?Object.fromEntries((m.positions??[]).map((p:any)=>[p.ticker,p.notice?.kind??null])):{};}
/** A new or different notice on a position already seen. A position seen for the first time is the silent baseline. */
export function detectMarketEvents(prev:Record<string,string|null>|null,next:Record<string,string|null>){
  if(!prev)return [];const out:{ticker:string;kind:string;sound:SoundName}[]=[];
  for(const [ticker,kind] of Object.entries(next))if(kind&&ticker in prev&&kind!==prev[ticker])out.push({ticker,kind,sound:MARKET_SOUNDS[kind]??'marketMove'});
  return out;
}
/** Every open dashboard tab sees the same markets notice; the first tab to claim it plays it. */
export function claimOnce(key:string,now:number,store:Pick<Storage,'getItem'|'setItem'>,windowMs=60000){
  try{const k='ka-claim:'+key,raw=store.getItem(k),last=raw===null?NaN:Number(raw);if(Number.isFinite(last)&&now-last<windowMs)return false;store.setItem(k,String(now));return true;}catch{return true;}
}
