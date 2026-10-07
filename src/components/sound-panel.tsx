'use client';
import {Play,Volume2,VolumeX} from 'lucide-react';
import {soundCatalog,categoryLabels,type Category,type SoundName,type SoundPrefs} from './sounds';
import {cn} from '@/lib/utils';
interface Props {prefs:SoundPrefs;setPrefs:(p:SoundPrefs)=>void;ready:boolean;test:(n:SoundName)=>void}
export function SoundToggle({prefs,setPrefs,ready}:Omit<Props,'test'>){
  const on=prefs.enabled,label=!on?'Sounds off':ready?'Sounds on':'Click anywhere to enable sound';
  return <button type="button" onClick={()=>setPrefs({...prefs,enabled:!on})} aria-pressed={on} aria-label={label} title={label}
    className={cn('inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl px-2.5 text-sm transition-colors',on&&ready?'text-yes hover:bg-surface-2':on?'text-warn hover:bg-surface-2':'text-faint hover:text-fg')}>
    {on?<Volume2 aria-hidden className="size-5"/>:<VolumeX aria-hidden className="size-5"/>}<span className="hidden lg:inline">{on?(ready?'Sound':'Tap for sound'):'Muted'}</span></button>;
}
export function SoundPanel({prefs,setPrefs,ready,test}:Props){
  const cats=Object.keys(categoryLabels) as Category[];
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={prefs.enabled} onChange={e=>setPrefs({...prefs,enabled:e.target.checked})}/>Sound alerts</label>
      <label className="flex min-h-11 flex-1 items-center gap-3 text-sm sm:max-w-xs"><span className="text-muted">Volume</span><input type="range" min={0} max={1} step={.05} value={prefs.volume} onChange={e=>setPrefs({...prefs,volume:Number(e.target.value)})} className="flex-1 accent-[var(--color-yes)]" aria-label="Alert volume"/><span className="num w-10 text-right">{Math.round(prefs.volume*100)}%</span></label>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={prefs.repeatSell} onChange={e=>setPrefs({...prefs,repeatSell:e.target.checked})}/>Repeat SELL NOW every 15 s</label>
    </div>
    {!ready&&prefs.enabled?<p className="text-xs text-warn">Your browser needs one click on this page before it can play sound — tap any Test button.</p>:null}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{cats.map(c=><fieldset key={c} className="rounded-xl border border-line p-4"><legend className="px-1">
      <label className="label flex cursor-pointer items-center gap-2"><input type="checkbox" checked={prefs.categories[c]} onChange={e=>setPrefs({...prefs,categories:{...prefs.categories,[c]:e.target.checked}})}/>{categoryLabels[c]}</label></legend>
      <ul className="mt-1 space-y-1">{soundCatalog.filter(s=>s.category===c).map(s=><li key={s.name} className="flex items-center justify-between gap-3 text-sm"><span className={prefs.categories[c]?'':'text-faint'}>{s.label}</span>
        <button type="button" onClick={()=>test(s.name)} className="inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs text-info transition-colors hover:bg-surface-2" aria-label={`Test ${s.label} sound`}><Play aria-hidden className="size-3.5"/>Test</button></li>)}</ul></fieldset>)}</div>
    <p className="text-xs text-faint">Sounds play while this page is open, even in a background tab. Settings are saved in this browser. Turn on “Browser notification” in Settings for pop-ups on SELL NOW, signals and profits.</p>
  </div>;
}
