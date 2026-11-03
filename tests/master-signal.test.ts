import {describe,it,expect} from 'vitest';
import {masterSignal,makerEntryPrice,IMPULSE_HOLD_MS,type MasterInput} from '../src/engine/master-signal';
import {baseFees} from '../src/engine/model/fees';
import type {FlowPulse} from '../src/engine/flow';
const pulse=(spot:number,perp:number,impulse:1|-1|0=0)=>({healthy:true,flow:{spot:{vote:spot},perp:{vote:perp}},lead:{impulse}}) as unknown as FlowPulse;
const up:MasterInput={fresh:true,stale:false,entriesClosed:false,liveCall:{direction:'UP',p:.62},openingCall:{direction:'UP'},pulse:pulse(1,1,1),impulse:{dir:1,ageMs:0},
  danger:{peakFee:null,lowVol:null},book:{yesBid:.55,yesAsk:.58,noBid:.42,noAsk:.45},schedule:baseFees};
describe('master signal',()=>{
  it('says STRONG BUY only when the calls, flow confirmed and a perp impulse agree on a fresh book',()=>{
    const s=masterSignal(up);
    expect(s).toMatchObject({kind:'buy',title:'STRONG BUY UP (YES)',side:'yes'});
    // Maker rests a cent above the 55¢ bid with no fee (maker multiplier 0); taker pays the 58¢ ask plus 1.71¢.
    expect(s.entry!.maker).toEqual({price:.56,fee:0});
    expect(s.entry!.taker.price).toBe(.58);expect(s.entry!.taker.fee).toBeCloseTo(.01705,5);
    const down=masterSignal({...up,liveCall:{direction:'DOWN'},openingCall:null,pulse:pulse(-1,-1,-1),impulse:{dir:-1,ageMs:1200}});
    expect(down).toMatchObject({kind:'buy',title:'STRONG BUY DOWN (NO)',side:'no'});expect(down.entry!.taker.price).toBe(.45);
  });
  it('waits on anything less',()=>{
    const reason=(i:Partial<MasterInput>)=>{const s=masterSignal({...up,...i});expect(s.kind).toBe('wait');expect(s.title).toBe('NO TRADE / WAIT');return s.reasons[0];};
    expect(reason({pulse:pulse(-1,-1,-1)})).toMatch(/FIGHTING THE FLOW/);
    expect(reason({pulse:pulse(1,0,1)})).toMatch(/FLOW MIXED/);
    expect(reason({pulse:null})).toMatch(/FLOW UNKNOWN/);
    expect(reason({stale:true,staleReasons:['Kalshi book 900 ms behind']})).toMatch(/Stale book.*900 ms/);
    expect(reason({openingCall:{direction:'DOWN'}})).toMatch(/disagree/);
    expect(reason({impulse:null})).toMatch(/no perp impulse UP/);
    expect(reason({impulse:{dir:1,ageMs:IMPULSE_HOLD_MS+1}})).toMatch(/no perp impulse/);
    expect(reason({impulse:{dir:-1,ageMs:0}})).toMatch(/no perp impulse/);
    expect(reason({entriesClosed:true})).toMatch(/final minute/);
    expect(reason({liveCall:null})).toMatch(/No live call/);
    expect(reason({book:{yesBid:.55,yesAsk:null,noBid:null,noAsk:null}})).toMatch(/No YES ask/);
    expect(reason({impulse:null,danger:{peakFee:{mid:.5,feePerContract:.0175},lowVol:{hour:22}}})).toMatch(/Danger zone \(9 PM–12 AM PT · price in the 40–60¢ fee peak \(50¢\)\) without a perp impulse/);
    expect(masterSignal({...up,fresh:false}).kind).toBe('paused');
  });
  it('still says STRONG BUY in the danger zone when the perp impulse is there, and says so',()=>{
    const s=masterSignal({...up,danger:{peakFee:null,lowVol:{hour:21}}});
    expect(s.kind).toBe('buy');expect(s.reasons[1]).toMatch(/danger zone \(9 PM–12 AM PT\)/);
  });
  it('turns into the exit for a position in the live round',()=>{
    const cmp=(ev:number|null,net:number|null)=>({hold:{ev},maker:net===null?null:{price:.7,fee:0,net}});
    const pos=(compare:any,action='HOLD')=>({side:'yes' as const,action,compare});
    expect(masterSignal({...up,position:pos(cmp(.5,.8))})).toMatchObject({kind:'hold',title:'HOLD TO $0-FEE SETTLEMENT',flow:'confirmed'});
    expect(masterSignal({...up,pulse:pulse(-1,-1,0),position:pos(cmp(.5,.2))})).toMatchObject({kind:'exit',title:'MAKER EXIT @ 70¢',exit:{price:.7,fee:0,net:.2}});
    // Mixed flow: whichever of A and B has the higher expected value.
    expect(masterSignal({...up,pulse:pulse(1,0),position:pos(cmp(.5,.8))}).kind).toBe('exit');
    expect(masterSignal({...up,pulse:pulse(1,0),position:pos(cmp(.9,.8))}).kind).toBe('hold');
    expect(masterSignal({...up,pulse:pulse(-1,-1),position:pos(cmp(.5,null))}).kind).toBe('hold');
    expect(masterSignal({...up,position:{...pos(null,'STALE BOOK'),stale:true}})).toMatchObject({kind:'paused',title:'EXIT PAUSED — STALE BOOK'});
    expect(masterSignal({...up,position:pos(null,'SETTLING')}).kind).toBe('hold');
    expect(masterSignal({...up,position:pos(cmp(.5,.8),'CUT LOSS')}).advice).toBe('CUT LOSS');
  });
  it('prices the maker entry inside the spread',()=>{
    expect(makerEntryPrice(.55,.58)).toBe(.56);expect(makerEntryPrice(.55,.56)).toBe(.55);expect(makerEntryPrice(null,.3)).toBe(.29);expect(makerEntryPrice(null,.01)).toBe(.01);
  });
});
