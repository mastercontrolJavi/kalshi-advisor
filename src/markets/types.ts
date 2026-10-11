/** Kalshi market data as the markets process uses it. Prices are dollars (0–1); null means Kalshi gave none. */
export type Group='sports'|'combos'|'politics'|'commodities';
export interface Leg {eventTicker:string;marketTicker:string;side:'yes'|'no'}
export interface Quote {ticker:string;eventTicker:string;seriesTicker:string;title:string;yesLabel:string;status:string;result:'yes'|'no'|null;yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null;last:number|null;volume24h:number|null;closeTime:number|null;expectedExpiration:number|null;legs:Leg[]|null;updated:number;strike?:number|null;rules?:string}
