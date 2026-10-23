const secs=(ms:number)=>ms>=10000?String(Math.round(ms/1000)):(ms/1000).toFixed(1);
/** Which side the delay comes from (engine delaySide): this computer, the internet connection or Kalshi. */
export function delayCause(k:any):string|null{
  if(k?.side==='engine')return `This computer is the hold-up: the app stalled for ${secs(k.loopLag??0)} s, so every feed is waiting. Close heavy programs or tabs.`;
  if(k?.side==='network')return `Your internet connection is the hold-up: the Coinbase and other exchange feeds are ${secs(k.exchangeDelay??0)} s behind too.`;
  if(k?.side==='kalshi')return 'Your connection looks fine (the exchange feeds are on time), so the hold-up is most likely on Kalshi’s end.';
  return null;
}
