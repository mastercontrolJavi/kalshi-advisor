import './globals.css';
import type {Viewport} from 'next';
import {Barlow_Condensed,IBM_Plex_Sans,JetBrains_Mono} from 'next/font/google';
// Self-hosted at build time by next/font, so the running app makes no font requests.
const barlow=Barlow_Condensed({subsets:['latin'],weight:['500','600','700'],variable:'--font-barlow',display:'swap'});
const plex=IBM_Plex_Sans({subsets:['latin'],weight:['400','500','600'],variable:'--font-plex',display:'swap'});
const jetbrains=JetBrains_Mono({subsets:['latin'],weight:['400','500','700'],variable:'--font-jetbrains',display:'swap'});
export const metadata={title:'Kalshi Advisor · BTC 15m',description:'Local Bitcoin probability, discipline and evidence'};
export const viewport:Viewport={width:'device-width',initialScale:1,themeColor:'#06080b'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en" className={`${barlow.variable} ${plex.variable} ${jetbrains.variable}`}><body>{children}</body></html>;}
