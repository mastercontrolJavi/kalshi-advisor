const secs=(ms:number)=>ms>=10000?String(Math.round(ms/1000)):(ms/1000).toFixed(1);
/** Which side the delay comes from (engine delaySide): this computer, the internet connection or Kalshi. */
export function delayCause(k:any):string|null{
  if(k?.side==='engine')return `This computer is the hold-up: the app stalled for ${secs(k.loopLag??0)} s, so every feed is waiting. Close heavy programs or tabs.`;
  if(k?.side==='network')return `Your internet connection is the hold-up: the Coinbase and other exchange feeds are ${secs(k.exchangeDelay??0)} s behind too.`;
  if(k?.side==='kalshi')return 'Your connection looks fine (the exchange feeds are on time), so the hold-up is most likely on Kalshi’s end.';
  return null;
}
/** While the stream is behind but the REST backup is current (DECISIONS 64): where the prices on screen come from. */
export function backupNote(k:any):string|null{
  if(k?.backup==null||k?.delayed)return null;
  return `Kalshi’s live stream is ${secs(k.delay??0)} s behind, so prices here come from Kalshi’s regular API instead (${secs(k.backup)} s old, re-read every second).`;
}
