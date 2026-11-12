'use client';
import type {ReactNode} from 'react';
import {cn} from '@/lib/utils';
const links=[{href:'/',label:'15-min'},{href:'/paper',label:'Paper'},{href:'/analytics',label:'Analytics'},{href:'/calibration',label:'Calibration'}];
/** Shared sticky header: brand, page navigation (current page marked), and optional page-specific status on the right. */
export function SiteHeader({current,aside,children,bottom}:{current:'/'|'/paper'|'/analytics'|'/calibration';aside?:ReactNode;children?:ReactNode;bottom?:ReactNode}){
  return <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/75 backdrop-blur-xl">
    <div className="mx-auto flex max-w-[1600px] 3xl:max-w-[2400px] 4xl:max-w-[3200px] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:gap-x-4 sm:px-6">
      <a href="/" className="flex items-center gap-2"><img src="/icon.svg" alt="" width={28} height={28} className="size-7"/><span className="font-display text-lg font-bold tracking-tight sm:text-xl">Kalshi Advisor</span></a>
      {aside}
      {/* Four pages are tight on a phone's width: the tab row scrolls on its own instead of the whole page. */}
      <nav aria-label="Pages" className="order-last flex w-full min-w-0 gap-0.5 overflow-x-auto rounded-full border border-line/70 bg-surface/70 p-1 [scrollbar-width:none] sm:order-none sm:ml-2 sm:w-auto [&::-webkit-scrollbar]:hidden">{links.map(l=><a key={l.href} href={l.href} aria-current={current===l.href?'page':undefined}
        className={cn('inline-flex min-h-9 flex-1 items-center justify-center whitespace-nowrap rounded-full px-2 text-sm font-medium sm:px-3.5 transition-colors sm:flex-none',current===l.href?'bg-surface-2 text-fg shadow-[0_1px_0_0_rgb(255_255_255/0.06)_inset]':'text-muted hover:text-fg')}>{l.label}</a>)}</nav>
      <div className="ml-auto flex items-center gap-2 text-sm">{children}</div>
    </div>
    {bottom}
  </header>;
}
