'use client';
import {useEffect} from 'react';

/** Page-level fallback. A stale build (chunks replaced by a rebuild while the tab was open) reloads itself once. */
export default function PageError({error,reset}:{error:Error&{digest?:string};reset:()=>void}){
  const stale=/ChunkLoadError|Loading chunk|dynamically imported module/i.test(`${error.name} ${error.message}`);
  useEffect(()=>{console.error(error);if(!stale)return;try{if(sessionStorage.getItem('stale-reload'))return;sessionStorage.setItem('stale-reload','1');}catch{return;}location.reload();},[error,stale]);
  useEffect(()=>{const t=setTimeout(()=>{try{sessionStorage.removeItem('stale-reload');}catch{}},30000);return()=>clearTimeout(t);},[]);
  return <main className="mx-auto max-w-xl px-4 py-24">
    <h1 className="font-display text-3xl font-bold">Something broke on this page</h1>
    <p className="mt-3 text-sm text-muted">{stale?'The app was rebuilt while this tab was open. Reload to load the new version.':error.message||'Unexpected error.'}</p>
    <div className="mt-6 flex gap-2">
      <button type="button" className="min-h-10 rounded-xl bg-surface-2 px-4 text-sm hover:text-fg" onClick={()=>stale?location.reload():reset()}>{stale?'Reload':'Try again'}</button>
      <button type="button" className="min-h-10 rounded-xl px-4 text-sm text-muted hover:text-fg" onClick={()=>location.reload()}>Reload page</button>
    </div>
  </main>;
}
