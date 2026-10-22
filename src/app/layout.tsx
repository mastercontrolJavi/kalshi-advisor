import './globals.css';
import type {Viewport} from 'next';
import {Bricolage_Grotesque,Manrope} from 'next/font/google';
// Self-hosted at build time by next/font, so the running app makes no font requests.
// 2026-10-22 redesign ("cooler, nicer, not too terminal"): a characterful grotesque for headlines and the action word,
// a warm geometric sans with tabular figures for everything else, replacing condensed caps and monospace numbers.
const display=Bricolage_Grotesque({subsets:['latin'],weight:['500','600','700','800'],variable:'--font-display-face',display:'swap'});
const sans=Manrope({subsets:['latin'],weight:['400','500','600','700'],variable:'--font-sans-face',display:'swap'});
export const metadata={title:'Kalshi Advisor · BTC 15m',description:'Local Bitcoin probability, discipline and evidence'};
export const viewport:Viewport={width:'device-width',initialScale:1,themeColor:'#0f1222'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en" className={`${display.variable} ${sans.variable}`}><body>{children}</body></html>;}
