/** Only a live, valid, two-sided and reasonably tight book is a usable forecast input. */
export function usableMid(book:{valid:boolean;updated:number;yesBid:number|null;yesAsk:number|null},now:number,maxAge:number,maxSpread=.1):number|null{
  const {yesBid:bid,yesAsk:ask}=book,age=now-book.updated;
  if(!book.valid||!Number.isFinite(age)||age<0||age>maxAge||bid===null||ask===null||!Number.isFinite(bid)||!Number.isFinite(ask)||bid<0||ask>1||ask<bid||ask-bid>maxSpread+1e-9)return null;
  return (bid+ask)/2;
}
