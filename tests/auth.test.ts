import {it,expect} from 'vitest';
import {authorized} from '../src/engine/auth';
it('HTTP and websocket share fail-closed basic authentication',()=>{process.env.DASHBOARD_USER='user';process.env.DASHBOARD_PASSWORD='secret';expect(authorized(undefined)).toBe(false);expect(authorized('Basic '+Buffer.from('user:wrong').toString('base64'))).toBe(false);expect(authorized('Basic '+Buffer.from('user:secret').toString('base64'))).toBe(true);delete process.env.DASHBOARD_PASSWORD;expect(authorized('Basic '+Buffer.from('user:secret').toString('base64'))).toBe(false);});
it('DASHBOARD_AUTH=off opens only genuine local requests; proxied, rebinding or remote requests still need the password',()=>{
  process.env.DASHBOARD_USER='user';process.env.DASHBOARD_PASSWORD='secret';
  const req=(host:string,addr='127.0.0.1',extra:Record<string,string>={})=>({headers:{host,...extra},socket:{remoteAddress:addr}}) as any;
  expect(authorized(undefined,req('localhost:3000'))).toBe(false);// default: password required
  process.env.DASHBOARD_AUTH='off';
  try{
    for(const h of ['localhost:3000','127.0.0.1:3001','[::1]:3000'])expect(authorized(undefined,req(h))).toBe(true);
    expect(authorized(undefined,req('localhost:3000','::ffff:127.0.0.1'))).toBe(true);
    expect(authorized(undefined,req('evil.example:3000'))).toBe(false);// DNS rebinding keeps the attacker's hostname
    expect(authorized(undefined,req('my-pc.tailnet.ts.net'))).toBe(false);// Tailscale serve
    expect(authorized(undefined,req('localhost:3000','127.0.0.1',{'x-forwarded-for':'100.64.0.2'}))).toBe(false);
    expect(authorized(undefined,req('localhost:3000','127.0.0.1',{'tailscale-user-login':'me@example.com'}))).toBe(false);
    expect(authorized(undefined,req('localhost:3000','192.168.1.20'))).toBe(false);// another machine on the LAN
    expect(authorized(undefined)).toBe(false);
    // The password still works for remote access.
    expect(authorized('Basic '+Buffer.from('user:secret').toString('base64'),req('my-pc.tailnet.ts.net'))).toBe(true);
  }finally{delete process.env.DASHBOARD_AUTH;}});
