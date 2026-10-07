'use client';
import type {ReactNode} from 'react';
import {cn} from '@/lib/utils';
const links=[{href:'/',label:'15-min'},{href:'/hourly',label:'Hourly'},{href:'/analytics',label:'Analytics'},{href:'/calibration',label:'Calibration'}];
/** Shared sticky header: brand, page navigation (current page marked), and optional page-specific status on the right. */
export function SiteHeader({current,aside,children,bottom}:{current:'/'|'/hourly'|'/analytics'|'/calibration';aside?:ReactNode;children?:ReactNode;bottom?:ReactNode}){
  return <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
    <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
      <a href="/" className="flex items-center gap-2.5"><img src="/icon.svg" alt="" width={28} height={28} className="size-7"/><span className="font-display text-xl font-bold tracking-wide">KALSHI<span className="text-yes">/ADVISOR</span></span></a>
      {aside}
      <nav aria-label="Pages" className="order-last flex w-full gap-1 sm:order-none sm:ml-2 sm:w-auto">{links.map(l=><a key={l.href} href={l.href} aria-current={current===l.href?'page':undefined}
        className={cn('inline-flex min-h-10 flex-1 items-center justify-center rounded-xl px-3 text-sm transition-colors sm:flex-none',current===l.href?'bg-surface-2 text-fg':'text-muted hover:text-fg')}>{l.label}</a>)}</nav>
      <div className="ml-auto flex items-center gap-2 text-sm">{children}</div>
    </div>
    {bottom}
  </header>;
}
