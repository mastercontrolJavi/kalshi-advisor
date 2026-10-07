import {timingSafeEqual} from 'node:crypto';
export function authorized(header:string|undefined){
  const user=process.env.DASHBOARD_USER,password=process.env.DASHBOARD_PASSWORD;
  if(!user||!password||!header?.startsWith('Basic '))return false;
  const actual=Buffer.from(header.slice(6),'base64'),expected=Buffer.from(user+':'+password);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export function requireDashboardCredentials(){if(!process.env.DASHBOARD_USER||!process.env.DASHBOARD_PASSWORD)throw new Error('DASHBOARD_USER and DASHBOARD_PASSWORD required in .env.local');}
