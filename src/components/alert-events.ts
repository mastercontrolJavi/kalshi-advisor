import type {SoundName} from './sounds';
/** The slice of live state that alerts react to. Sounds fire on transitions only, never on the first snapshot. */
export interface AlertSnapshot {ticker:string|null;tau:number|null;entryAt:number;ideaKey:string|null;ideaSide:string|null;exits:Record<string,string>;pnl:number|null;day:string|null;liveDir:string|null;unreliable:boolean;locked:boolean}
export function snapshot(s:any,fresh:boolean):AlertSnapshot{
  const idea=fresh?s?.evaluation?.idea:null;
  return {ticker:s?.market?.ticker??null,tau:s?.market?s.tau:null,entryAt:s?.config?.sweetMaxSeconds??300,ideaKey:idea?[s.ticker,idea.side,idea.price].join(':'):null,ideaSide:idea?.side??null,
    exits:Object.fromEntries((fresh?s?.exits??[]:[]).map((e:any)=>[e.ticker,e.action])),pnl:s?.guards?.pnl??null,day:s?.guards?.today??null,
    liveDir:fresh?s?.liveCall?.direction??null:null,unreliable:!fresh||s?.quality?.level==='unreliable',locked:!!s?.guards?.locked};
}
// Most important first; the player spaces them out and caps how many play per update.
export const priority:SoundName[]=['sell','lock','buyYes','buyNo','win','loss','warning','hold','flipUp','flipDown','newWindow','entryWindow','finalMinute'];
export function detectEvents(prev:AlertSnapshot|null,next:AlertSnapshot):SoundName[]{
  if(!prev)return [];
  const out=new Set<SoundName>();
  if(next.ideaKey&&next.ideaKey!==prev.ideaKey)out.add(next.ideaSide==='yes'?'buyYes':'buyNo');
  for(const [ticker,action] of Object.entries(next.exits)){const before=prev.exits[ticker];
    if(action==='SELL NOW'&&before!=='SELL NOW')out.add('sell');
    if(action==='HOLD'&&(before===undefined||before==='SELL NOW'))out.add('hold');}
  if(prev.pnl!==null&&next.pnl!==null&&prev.day===next.day){const d=next.pnl-prev.pnl;if(d>.005)out.add('win');else if(d<-.005)out.add('loss');}
  const sameWindow=prev.ticker!==null&&prev.ticker===next.ticker;
  if(prev.ticker!==null&&next.ticker!==null&&next.ticker!==prev.ticker)out.add('newWindow');
  if(sameWindow&&prev.liveDir&&next.liveDir&&prev.liveDir!==next.liveDir)out.add(next.liveDir==='UP'?'flipUp':'flipDown');
  if(sameWindow&&prev.tau!==null&&next.tau!==null){if(prev.tau>next.entryAt&&next.tau<=next.entryAt)out.add('entryWindow');if(prev.tau>60&&next.tau<=60)out.add('finalMinute');}
  if(!prev.unreliable&&next.unreliable)out.add('warning');
  if(!prev.locked&&next.locked)out.add('lock');
  return priority.filter(n=>out.has(n));
}
