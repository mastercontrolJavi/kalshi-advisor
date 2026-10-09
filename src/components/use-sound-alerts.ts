'use client';
import {useEffect,useRef,useState} from 'react';
import {SoundEngine,soundCatalog,loadPrefs,savePrefs,defaultPrefs,type SoundName,type SoundPrefs} from './sounds';
import {snapshot,detectEvents,marketsSnapshot,detectMarketEvents,claimOnce,type AlertSnapshot} from './alert-events';
const categoryOf=Object.fromEntries(soundCatalog.map(s=>[s.name,s.category])) as Record<SoundName,keyof SoundPrefs['categories']>;
const SELL_REPEAT_MS=15000,WARNING_GAP_MS=30000,SPACING_MS=650,MAX_PER_UPDATE=3;
/**
 * Plays alert sounds (and optional browser notifications) on state transitions. Prefs are per-browser. `markets` is the
 * markets process's live state: its notices sound on every page, and only one open tab plays each one.
 */
export function useSoundAlerts(s:any,fresh:boolean,page:'15m'|'hourly'|'markets'='15m',markets?:{state:any;fresh:boolean}){
  const engine=useRef<SoundEngine|null>(null),prev=useRef<AlertSnapshot|null>(null),lastSell=useRef(Date.now()),lastWarning=useRef(0),prevMarkets=useRef<Record<string,string|null>|null>(null);
  const [prefs,setPrefsState]=useState<SoundPrefs>(defaultPrefs),[ready,setReady]=useState(false);
  useEffect(()=>{setPrefsState(loadPrefs());engine.current=new SoundEngine();
    // Browsers block audio until a user gesture; any click or key press on the page arms it.
    const unlock=()=>{engine.current?.unlock();setTimeout(()=>setReady(!!engine.current?.ready),80);};
    window.addEventListener('pointerdown',unlock);window.addEventListener('keydown',unlock);
    // Start audio right away: where the browser allows it (the desktop shortcut's window does) sound is on without a click.
    unlock();
    return()=>{window.removeEventListener('pointerdown',unlock);window.removeEventListener('keydown',unlock);engine.current?.close();};
  },[]);
  useEffect(()=>{
    if(!s)return;
    const next=snapshot(s,fresh,page==='markets'?'15m':page),events=detectEvents(prev.current,next),now=Date.now();prev.current=next;
    // Exit alerts repeat while they stand, so a take-profit or stop is never missed.
    const standing=Object.values(next.exits).map(a=>a==='TAKE PROFIT'?'takeProfit':a==='CUT LOSS'?'cutLoss':a==='SELL NOW'?'sell':null).find(Boolean) as SoundName|undefined;
    if(prefs.repeatSell&&standing&&!events.some(e=>e==='takeProfit'||e==='cutLoss'||e==='sell')&&now-lastSell.current>=SELL_REPEAT_MS)events.unshift(standing);
    const playable=events.filter(n=>n!=='warning'||now-lastWarning.current>=WARNING_GAP_MS).filter(n=>prefs.enabled&&prefs.categories[categoryOf[n]]).slice(0,MAX_PER_UPDATE);
    if(playable.some(e=>e==='sell'||e==='takeProfit'||e==='cutLoss'))lastSell.current=now;if(playable.includes('warning'))lastWarning.current=now;
    playable.forEach((n,i)=>setTimeout(()=>engine.current?.play(n,prefs.volume),i*SPACING_MS));
    if(s.config?.notifications&&typeof Notification!=='undefined'&&Notification.permission==='granted'){
      const exit=((page==='hourly'?s.hourly?.exits:s.exits)??[]).find((e:any)=>['TAKE PROFIT','CUT LOSS','SELL NOW'].includes(e.action));
      if(exit&&events.some(e=>e==='sell'||e==='takeProfit'||e==='cutLoss'))new Notification(exit.action,{body:String(exit.reason).split(' Plan: ')[0],tag:'exit'});
      if((events.includes('buyYes')||events.includes('buyNo'))&&page==='hourly')new Notification(s.hourly?.action??'Hourly signal',{body:String(s.hourly?.reason??''),tag:'signal'});
      else if(events.includes('buyYes')||events.includes('buyNo'))new Notification(s.evaluation.action,{body:s.evaluation.reason+(s.backtest?` · Backtest: this rule averaged ${(s.backtest.buy15.mean*100).toFixed(1)}¢ per contract`:''),tag:'signal'});
      const moved=((page==='hourly'?s.hourly?.exits:s.exits)??[]).find((e:any)=>e.notice);
      if(events.includes('positionMove')&&moved)new Notification(moved.notice.title,{body:moved.notice.text,tag:'position'});
      if(events.includes('win'))new Notification('Profit',{body:`P&L today ${s.guards.pnl>=0?'+':'−'}$${Math.abs(s.guards.pnl).toFixed(2)}`,tag:'result'});
    }
  },[s,fresh,prefs,page]);
  const mState=markets?.state,mFresh=!!markets?.fresh;
  useEffect(()=>{
    if(!mFresh)return;
    const next=marketsSnapshot(mState,true),events=detectMarketEvents(prevMarkets.current,next);prevMarkets.current=next;
    if(!prefs.enabled||!prefs.categories.markets)return;
    const playable=events.filter(e=>{try{return claimOnce(e.ticker+':'+e.kind,Date.now(),localStorage);}catch{return true;}}).slice(0,MAX_PER_UPDATE);
    playable.forEach((e,i)=>setTimeout(()=>engine.current?.play(e.sound,prefs.volume),i*SPACING_MS));
  },[mState,mFresh,prefs]);
  const setPrefs=(p:SoundPrefs)=>{setPrefsState(p);savePrefs(p);};
  const test=(name:SoundName)=>{engine.current?.unlock();setTimeout(()=>{setReady(!!engine.current?.ready);engine.current?.play(name,prefs.volume);},80);};
  return {prefs,setPrefs,ready,test};
}
