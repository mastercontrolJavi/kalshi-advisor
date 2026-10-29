import {it,expect} from 'vitest';
import {classifySetup,describeSetup,windowOf,SETUPS_FOUND,type SetupStats} from '../src/backtest/setups';
import {setupStats} from '../src/backtest/setup-stats';
import {spotSeries,spotAt} from '../src/backtest/sim';
import {fee} from '../src/engine/model/fees';
// sigma 1.5e-5/s at $80k: a normal minute is ~$9.30, and with 400 s left one z unit is ~$24.
const base={tau:400,k:80000,sigma:1.5e-5};
it('names the chart setup from distance to the target and the last minute',()=>{
  expect(classifySetup({...base,spot:80003,spot60:80000})!.kind).toBe('coinflip');
  expect(classifySetup({...base,spot:80015,spot60:80010})).toMatchObject({kind:'trend',side:'yes'});
  expect(classifySetup({...base,spot:79950,spot60:79952})).toMatchObject({kind:'strong',side:'no'});
  // Above the target but fell ~$10 (about one normal minute) in the last minute: a dip in an uptrend.
  expect(classifySetup({...base,spot:80015,spot60:80025})).toMatchObject({kind:'dip',side:'yes'});
  expect(classifySetup({...base,spot:80015,spot60:null})!.kind).toBe('trend');
  expect(classifySetup({...base,sigma:0,spot:80015,spot60:null})).toBeNull();
  expect([windowOf(700),windowOf(450),windowOf(200),windowOf(60),windowOf(890)]).toEqual(['15–10','10–5','5–2',null,'15–10']);
});
it('describes the setup with its past record and flags coin flips and losing sides',()=>{
  const r=(mean:number,lo:number,hi:number)=>({n:500,mean,ci:[lo,hi] as [number,number],early:mean,late:mean,win:.8,paid:.79});
  const stats:SetupStats[]=[{window:'10–5',kind:'dip',with:r(.005,-.006,.016),against:r(-.034,-.044,-.023)},{window:'10–5',kind:'strong',with:r(.02,.005,.035),against:r(-.03,-.04,-.02)}];
  const dip=describeSetup(classifySetup({...base,spot:80015,spot60:80025})!,stats);
  expect(dip.title).toBe('Dip in a trend UP');expect(dip.lines[0]).toContain('about a fair price');expect(dip.lines[1]).toContain('Chasing the bounce (NO)');expect(dip.lines[1]).toContain('loses money');
  // A record that clears the bar on its whole history is not an edge until rounds after the setups were found clear it too.
  const strong=describeSetup(classifySetup({...base,spot:80060,spot60:80058})!,stats);
  expect(strong.tone).toBe('neutral');expect(strong.lines[0]).toContain('unconfirmed: since it was found on Oct 17 it has not been checked on new rounds yet');
  const withAfter=(after:any)=>[{window:'10–5' as const,kind:'strong' as const,with:{...r(.02,.005,.035),after},against:r(-.03,-.04,-.02)}];
  const failed=describeSetup(classifySetup({...base,spot:80060,spot60:80058})!,withAfter({...r(-.014,-.065,.038),n:165}));
  expect(failed.tone).toBe('neutral');expect(failed.lines[0]).toContain('since it was found on Oct 17 it made −1.4¢ over 165 rounds (likely −6.5¢ to +3.8¢)');
  const earned=describeSetup(classifySetup({...base,spot:80060,spot60:80058})!,withAfter({...r(.02,.004,.036),n:300}));
  expect(earned.tone).toBe('yes');expect(earned.lines[0]).toContain('a small edge, in both halves of the record and on rounds since it was found');
  expect(describeSetup(classifySetup({...base,spot:80003,spot60:80000})!,stats).tone).toBe('warn');
  expect(describeSetup(classifySetup({...base,tau:30,spot:80060,spot60:80058})!,stats).lines[0]).toMatch(/No past record/);
});
it('scores every setup again on the rounds after it was found, with their own halves',()=>{
  const day=86400,opens=[-2,-1,1,2].map(k=>SETUPS_FOUND+k*day),results=['yes','yes','no','yes'];
  // Coinbase minutes rising by 0.04% or 0.07%: volatility is known, no minute moves back, so BTC 2% above K is a strong trend.
  const rows:any[]=[];let p=80000;for(let ts=opens[0]-3*3600;ts<=opens[3]+900;ts+=60){p*=1+(ts/60%2?.0007:.0004);rows.push({ts,open:p,high:p,low:p,close:p,volume:1});}
  const s=spotSeries(rows),markets=opens.map((open,i)=>({ticker:`M${i}`,series:'KXBTC15M',event:null,open_ts:open,close_ts:open+900,strike:spotAt(s,open)!.price*.98,result:results[i],settle:null,volume:0,source:'test',candles:1}));
  const candles=new Map(markets.map(m=>[m.ticker,[{ticker:m.ticker,ts:m.open_ts,bid:.84,ask:.85,bid_lo:null,bid_hi:null,ask_lo:null,ask_hi:null,price:null,volume:null}]]));
  const cell=setupStats(markets as any,candles as any,s,()=>0).find(x=>x.window==='15–10'&&x.kind==='strong')!.with!;
  const net=(win:boolean)=>(win?1:0)-.85-fee(.85);
  expect(cell.n).toBe(4);expect(cell.after!.n).toBe(2);expect(cell.after!.mean).toBeCloseTo((net(false)+net(true))/2);
  expect(cell.after!.early).toBeCloseTo(net(false));expect(cell.after!.late).toBeCloseTo(net(true));
});
