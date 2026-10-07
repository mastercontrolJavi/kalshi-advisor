export const dollars=(v:number|null|undefined,digits=2)=>v==null||!Number.isFinite(v)?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(v);
export const signedDollars=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?'—':`${v>0?'+':v<0?'−':''}${dollars(Math.abs(v))}`;
export const cents=(v:number|null|undefined,digits=1)=>v==null||!Number.isFinite(v)?'—':`${(v*100).toFixed(digits)}¢`;
export const signedCents=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?'—':`${v>0?'+':v<0?'−':''}${Math.abs(v*100).toFixed(1)}¢`;
export const pct=(v:number|null|undefined,digits=1)=>v==null||!Number.isFinite(v)?'—':`${(v*100).toFixed(digits)}%`;
export const qty=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?'—':v.toLocaleString('en-US',{maximumFractionDigits:2});
export const mmss=(seconds:number)=>{const s=Math.max(0,Math.floor(seconds));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
export const ago=(ms:number)=>ms<1000?`${Math.round(ms)}ms`:ms<60000?`${(ms/1000).toFixed(ms<10000?1:0)}s`:`${Math.floor(ms/60000)}m ${Math.floor(ms%60000/1000)}s`;
