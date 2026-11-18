import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']),LOCAL_HOSTS=new Set(['localhost','127.0.0.1','[::1]']);
/** DASHBOARD_AUTH=off in .env.local: requests made on this PC skip the password (user request, for easy local testing). */
export const localAuthOff=()=>process.env.DASHBOARD_AUTH==='off';
/**
 * A request counts as local only if it arrives on loopback, addresses localhost by name or IP (so a DNS-rebinding page
 * with its own hostname is refused) and carries no proxy headers. Tailscale serve also connects from loopback, but sends
 * the ts.net Host and X-Forwarded-For / Tailscale-* headers, so the phone still needs the password.
 */
export function isLocalRequest(req:Pick<IncomingMessage,'headers'|'socket'>|undefined){
  if(!req||!LOOPBACK.has(req.socket?.remoteAddress??''))return false;
  const host=String(req.headers.host??'').toLowerCase().replace(/:\d+$/,'');if(!LOCAL_HOSTS.has(host))return false;
  return !req.headers['x-forwarded-for']&&!req.headers.forwarded&&!Object.keys(req.headers).some(k=>k.startsWith('tailscale-'));
}
export function authorized(header:string|undefined,req?:Pick<IncomingMessage,'headers'|'socket'>){
  if(localAuthOff()&&isLocalRequest(req))return true;
  const user=process.env.DASHBOARD_USER,password=process.env.DASHBOARD_PASSWORD;
  if(!user||!password||!header?.startsWith('Basic '))return false;
  const actual=Buffer.from(header.slice(6),'base64'),expected=Buffer.from(user+':'+password);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export function requireDashboardCredentials(){if(localAuthOff())return;if(!process.env.DASHBOARD_USER||!process.env.DASHBOARD_PASSWORD)throw new Error('DASHBOARD_USER and DASHBOARD_PASSWORD required in .env.local (or DASHBOARD_AUTH=off for local-only access)');}
/** The request's path, or null for a target the URL parser rejects ("//", "//a:b"): never throws, so a bad request cannot
 * become an unhandled rejection in the engine's async HTTP handler (2026-11-17 audit). */
export function requestPath(url:string|undefined):string|null{try{return new URL(url??'/','http://127.0.0.1').pathname;}catch{return null;}}
