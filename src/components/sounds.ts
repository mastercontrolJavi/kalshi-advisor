'use client';
/** Synthesized alert sounds (Web Audio, no files). Each event has a distinct contour so it is recognisable without looking. */
export type SoundName='buyYes'|'buyNo'|'sell'|'hold'|'win'|'loss'|'flipUp'|'flipDown'|'newWindow'|'entryWindow'|'finalMinute'|'closingUp'|'closingDown'|'setup'|'takeProfit'|'cutLoss'|'warning'|'lock';
export type Category='signals'|'positions'|'results'|'calls'|'timing'|'warnings';
export const soundCatalog:{name:SoundName;label:string;category:Category}[]=[
  {name:'buyYes',label:'BUY YES signal',category:'signals'},{name:'buyNo',label:'BUY NO signal',category:'signals'},{name:'setup',label:'Scalp / dip setup appears',category:'signals'},
  {name:'takeProfit',label:'TAKE PROFIT on your position (repeats)',category:'positions'},{name:'cutLoss',label:'CUT LOSS on your position (repeats)',category:'positions'},{name:'sell',label:'SELL NOW on your position (repeats)',category:'positions'},{name:'hold',label:'HOLD your position',category:'positions'},
  {name:'win',label:'Win / profit',category:'results'},{name:'loss',label:'Loss',category:'results'},
  {name:'flipUp',label:'Live call flips UP',category:'calls'},{name:'flipDown',label:'Live call flips DOWN',category:'calls'},
  {name:'newWindow',label:'New 15-min window',category:'timing'},{name:'entryWindow',label:'Entry window opens (5:00 left)',category:'timing'},{name:'finalMinute',label:'Final minute (no call)',category:'timing'},{name:'closingUp',label:'Closing call: UP into the final minute',category:'calls'},{name:'closingDown',label:'Closing call: DOWN into the final minute',category:'calls'},
  {name:'warning',label:'Data unreliable / connection lost',category:'warnings'},{name:'lock',label:'Guardrail lock',category:'warnings'}
];
export const categoryLabels:Record<Category,string>={signals:'Trade signals',positions:'Hold / sell',results:'Wins & losses',calls:'Live call flips',timing:'Window timing',warnings:'Warnings'};
export interface SoundPrefs {enabled:boolean;volume:number;categories:Record<Category,boolean>;repeatSell:boolean}
export const defaultPrefs:SoundPrefs={enabled:true,volume:.6,categories:{signals:true,positions:true,results:true,calls:true,timing:true,warnings:true},repeatSell:true};
const KEY='kalshi-advisor-sounds';
export function loadPrefs():SoundPrefs{try{const raw=localStorage.getItem(KEY);if(!raw)return defaultPrefs;const p=JSON.parse(raw);return {...defaultPrefs,...p,categories:{...defaultPrefs.categories,...p.categories}};}catch{return defaultPrefs;}}
export function savePrefs(p:SoundPrefs){try{localStorage.setItem(KEY,JSON.stringify(p));}catch{}}

type Note=[freq:number,start:number,duration:number,type?:OscillatorType,gain?:number,glideTo?:number];
const C5=523.25,E5=659.25,G5=783.99,C6=1046.5,G4=392,A4=440,E4=329.63,B3=246.94;
const scores:Record<SoundName,Note[]>={
  buyYes:[[C5,0,.14,'triangle'],[G5,.13,.22,'triangle']],
  buyNo:[[G5,0,.14,'triangle'],[C5,.13,.22,'triangle']],
  sell:[[C6,0,.09,'square',.55],[C6,.15,.09,'square',.55],[C6,.3,.09,'square',.55],[1318.5,.45,.18,'square',.5]],
  hold:[[A4,0,.35,'sine',.9],[554.37,.08,.4,'sine',.5]],
  win:[[C5,0,.1,'triangle'],[E5,.08,.1,'triangle'],[G5,.16,.1,'triangle'],[C6,.24,.35,'triangle'],[2093,.3,.25,'sine',.25]],
  loss:[[E4,0,.25,'sine',.8],[B3,.2,.4,'sine',.8]],
  flipUp:[[660,0,.14,'sine',.7,990]],
  flipDown:[[990,0,.14,'sine',.7,660]],
  newWindow:[[G4,0,.2,'sine'],[C5,.14,.2,'sine'],[E5,.28,.35,'sine']],
  entryWindow:[[G5,0,.18,'sine',.6],[987.77,.16,.3,'sine',.6]],
  finalMinute:[[1200,0,.05,'square',.35],[900,.22,.05,'square',.35]],
  closingUp:[[1200,0,.05,'square',.3],[E5,.18,.12,'triangle'],[G5,.3,.12,'triangle'],[C6,.42,.3,'triangle']],
  closingDown:[[1200,0,.05,'square',.3],[C6,.18,.12,'triangle'],[G5,.3,.12,'triangle'],[E5,.42,.3,'triangle']],
  takeProfit:[[G5,0,.1,'triangle'],[C6,.1,.1,'triangle'],[G5,.2,.1,'triangle'],[C6,.3,.3,'triangle'],[2093,.36,.2,'sine',.3]],
  cutLoss:[[880,0,.12,'sawtooth',.5],[660,.16,.12,'sawtooth',.5],[440,.32,.3,'sawtooth',.5]],
  setup:[[1568,0,.08,'sine',.7],[2093,.1,.14,'sine',.6]],
  warning:[[220,0,.18,'sawtooth',.5],[220,.26,.18,'sawtooth',.5]],
  lock:[[150,0,.22,'square',.5],[150,.3,.22,'square',.5],[110,.6,.4,'square',.5]]
};
export class SoundEngine {
  private ctx:AudioContext|null=null;
  /** Browsers only allow audio after a user gesture; call from a click, and on any later interaction. */
  unlock(){try{this.ctx??=new AudioContext();if(this.ctx.state==='suspended')void this.ctx.resume();}catch{}}
  get ready(){return this.ctx?.state==='running';}
  play(name:SoundName,volume:number){
    const ctx=this.ctx;if(!ctx||ctx.state!=='running'||volume<=0)return;
    const master=ctx.createGain();master.gain.value=Math.min(1,volume)*.35;master.connect(ctx.destination);const t0=ctx.currentTime+.01;
    for(const [freq,start,dur,type='sine',gain=1,glide] of scores[name]){
      const osc=ctx.createOscillator(),env=ctx.createGain(),t=t0+start;osc.type=type;osc.frequency.setValueAtTime(freq,t);if(glide)osc.frequency.exponentialRampToValueAtTime(glide,t+dur);
      env.gain.setValueAtTime(0,t);env.gain.linearRampToValueAtTime(gain,t+.01);env.gain.exponentialRampToValueAtTime(.0001,t+dur);
      osc.connect(env).connect(master);osc.start(t);osc.stop(t+dur+.02);
    }
  }
  close(){void this.ctx?.close();this.ctx=null;}
}
