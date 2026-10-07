'use client';
import {useState} from 'react';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {type Config} from '@/engine/config';
const descriptions:Partial<Record<keyof Config,string>>={minEdge:'Minimum taker edge (dollars)',earlyEdge:'Edge outside sweet spot (dollars)',maxRiskPerTrade:'Maximum balance risk fraction',kellyFraction:'Kelly fraction',dailyLossLimit:'Daily loss fraction',feePrecision:'Account precision: 0.0001 direct / 0.01 non-direct',basisCorrection:'Proxy correction (USD)',staleMs:'Venue stale age (milliseconds)',realizedBlend:'Realized volatility blend (0–1)',halfLifeSeconds:'EWMA half-life (seconds)'};
export default function Settings({config}:{config:Config}){
  const [draft,setDraft]=useState<Config>(config),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  async function save(){setSaving(true);try{if(draft.notifications&&'Notification' in window)await Notification.requestPermission();const r=await fetch('/api/engine/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});const d=await r.json();if(!r.ok)throw new Error(d.error);setMessage('Saved to local journal');}catch(e){setMessage((e as Error).message);}finally{setSaving(false);}}
  return <div className="mt-5"><p className="mb-4 text-sm text-zinc-400">Prices and edge thresholds are in dollars: 0.04 = 4¢. Fractions: 0.02 = 2%. Changes apply immediately.</p><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(draft).map(([key,value])=><label key={key} className="flex flex-col gap-2 text-xs text-zinc-300"><span>{descriptions[key as keyof Config]??key.replace(/([A-Z])/g,' $1')}</span>{typeof value==='boolean'?<input type="checkbox" checked={value} onChange={e=>setDraft({...draft,[key]:e.target.checked})}/>:<Input type="number" step="any" value={value} onChange={e=>setDraft({...draft,[key]:Number(e.target.value)})}/>}</label>)}</div><div className="mt-5 flex items-center gap-4"><Button onClick={save} disabled={saving}>{saving?'Saving…':'Save settings'}</Button><span role="status" className="text-sm">{message}</span></div></div>;
}
