'use client';
import {useEffect,useState} from 'react';
import {cn} from '@/lib/utils';
export const FILTERS:[string,string][]=[['all','All'],['sports','Sports'],['combos','Combos'],['politics','Politics & econ'],['commodities','Commodities & crypto']];
const SECTIONS:[string,string,string][]=[['positions','/markets','Positions'],['scan','/markets/scan','Scanner'],['sharps','/markets/sharps','Sharps'],['record','/markets/record','Record']];
const KEY='markets:filter';
const chip=(on:boolean)=>cn('inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-sm transition-colors',on?'bg-surface-2 text-fg':'text-muted hover:text-fg');
/** The chosen category, shared by every Markets tab and remembered per browser. */
export function useMarketsFilter(){
  const [filter,setState]=useState('all');
  useEffect(()=>{try{const v=localStorage.getItem(KEY);if(v&&FILTERS.some(([k])=>k===v))setState(v);}catch{}},[]);
  return [filter,(v:string)=>{setState(v);try{localStorage.setItem(KEY,v);}catch{}}] as const;
}
/** Markets sections (Positions · Scanner · Sharps · Record) and the category chips under them. Counts are shown when given. */
export function MarketsNav({current,filter,setFilter,counts}:{current:'positions'|'scan'|'sharps'|'record';filter:string;setFilter:(v:string)=>void;counts?:Record<string,number>}){
  return <div className="space-y-2">
    <nav aria-label="Markets sections" className="flex flex-wrap gap-1">{SECTIONS.map(([k,href,l])=><a key={k} href={href} aria-current={current===k?'page':undefined} className={cn(chip(current===k),'font-medium')}>{l}</a>)}</nav>
    <nav aria-label="Filter by category" className="flex flex-wrap gap-1">{FILTERS.map(([k,l])=><button key={k} type="button" aria-pressed={filter===k} onClick={()=>setFilter(k)} className={chip(filter===k)}>
      {l}{counts?<span className="num text-xs text-faint">{counts[k]??0}</span>:null}</button>)}</nav>
  </div>;
}
