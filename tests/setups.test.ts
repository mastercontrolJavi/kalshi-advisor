import {it,expect} from 'vitest';
import {classifySetup,describeSetup,windowOf,type SetupStats} from '../src/backtest/setups';
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
  const strong=describeSetup(classifySetup({...base,spot:80060,spot60:80058})!,stats);
  expect(strong.tone).toBe('yes');expect(strong.lines[0]).toContain('a small edge');
  expect(describeSetup(classifySetup({...base,spot:80003,spot60:80000})!,stats).tone).toBe('warn');
  expect(describeSetup(classifySetup({...base,tau:30,spot:80060,spot60:80058})!,stats).lines[0]).toMatch(/No past record/);
});
