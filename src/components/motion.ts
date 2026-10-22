'use client';
import {useEffect,useRef} from 'react';
import gsap from 'gsap';
/**
 * Motion with a job (GSAP, 2026-10-22): draw the eye to what just changed, never to decoration. Transforms and filters
 * only, so live updates never move the layout; nothing runs when the system asks for reduced motion.
 */
const reduced=()=>typeof window!=='undefined'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Briefly lights the element when `key` changes (a new call, a fill, a settled round); not on first render. */
export function useFlash<T extends HTMLElement>(key:unknown){
  const ref=useRef<T>(null),seen=useRef<unknown>(key);
  useEffect(()=>{
    if(Object.is(seen.current,key))return;seen.current=key;const el=ref.current;if(!el||reduced())return;
    const t=gsap.fromTo(el,{scale:1.035,filter:'brightness(1.7)'},{scale:1,filter:'brightness(1)',duration:.7,ease:'power3.out',clearProps:'transform,filter'});
    return()=>{t.kill();};
  },[key]);
  return ref;
}
/** Rolls a figure to its new value (cash, realized P&L) instead of jumping; the span's text is owned by this hook. */
export function useCountUp(value:number|null|undefined,format:(v:number)=>string){
  const ref=useRef<HTMLSpanElement>(null),shown=useRef<number|null>(null),fmt=useRef(format);fmt.current=format;
  useEffect(()=>{
    const el=ref.current;if(!el)return;
    if(value==null||!Number.isFinite(value)){el.textContent='—';shown.current=null;return;}
    const from=shown.current;if(from===null||reduced()||from===value){el.textContent=fmt.current(value);shown.current=value;return;}
    const o={v:from},t=gsap.to(o,{v:value,duration:.6,ease:'power2.out',onUpdate:()=>{el.textContent=fmt.current(o.v);shown.current=o.v;},onComplete:()=>{shown.current=value;}});
    return()=>{t.kill();};
  },[value]);
  return ref;
}
/** Staggers the direct children in once, on mount (the page's one orchestrated entrance). */
export function useEntrance<T extends HTMLElement>(){
  const ref=useRef<T>(null);
  useEffect(()=>{const el=ref.current;if(!el||reduced())return;
    const ctx=gsap.context(()=>{gsap.from(el.children,{opacity:0,y:10,duration:.5,ease:'power3.out',stagger:.06,clearProps:'opacity,transform'});},el);
    return()=>ctx.revert();},[]);
  return ref;
}
