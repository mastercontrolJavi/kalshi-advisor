const secs=(ms:number)=>ms>=10000?String(Math.round(ms/1000)):(ms/1000).toFixed(1);
/** Observed delay patterns identify possible causes, not which provider or network hop is at fault. */
export function delayCause(k:any):string|null{
  if(k?.side==='engine')return (k.loopBusy??0)>=.8&&(k.loopLag??0)<=1000?`The app has been busy ${Math.round(k.loopBusy*100)}% of the last 5 s, so incoming prices wait in line. Close heavy programs if this persists.`
    :`The app recently stalled for ${secs(k.loopLag??0)} s, which can delay incoming prices.`;
  if(k?.side==='network')return `Coinbase and the other exchange feeds are ${secs(k.exchangeDelay??0)} s behind too; a shared connection delay may be contributing.`;
  if(k?.side==='kalshi')return 'Other exchange feeds are current. The delay is isolated to the Kalshi stream; the exact cause is not established.';
  return null;
}
/** While the stream is behind but the REST backup is current (DECISIONS 64): where the prices on screen come from. */
export function backupNote(k:any):string|null{
  if(k?.backup==null||k?.delayed)return null;
  return `Kalshi’s live stream is ${secs(k.delay??0)} s behind. Prices are using the REST backup (${secs(k.backup)} s old).${k.recovery?.waitingForSnapshot?' Reconnecting the stream and waiting for a current book.':''}`;
}
