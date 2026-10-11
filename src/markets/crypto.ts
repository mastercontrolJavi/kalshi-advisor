import {ProxyFeed,type Coin} from '../engine/feeds/proxy';
import {probability,volatility,filledSeconds} from '../engine/model/math';
import {predict,priorFit} from '../engine/quant/stack';
import type {Quote} from './types';
/**
 * Stage 5: Kalshi's other 15-minute crypto rounds, priced with the Bitcoin model. Every one checked on 2026-10-10 settles
 * like KXBTC15M: the simple average of the 60 s of the coin's CF Benchmarks RTI before the close against the same average
 * before the open. A series is priced only when its market's rules_primary says exactly that (RULE); anything else is
 * refused rather than modelled with the wrong settlement. Spot is the median of Coinbase, Kraken, Bitstamp and Gemini, as
 * for Bitcoin. No proxy→RTI basis is learned for these coins (Bitcoin's is a few dollars), so the model is a little rougher.
 * As for Bitcoin, the forecast used is the default blend of the model with Kalshi's mid (the backtest found Kalshi's price
 * at least as accurate as the model with more than a minute left).
 */
export const CRYPTO15:Record<string,Coin>={KXETH15M:'ETH',KXSOL15M:'SOL',KXXRP15M:'XRP',KXDOGE15M:'DOGE'};
const RULE=/simple average of the sixty seconds of CF Benchmarks' (\w+RTI) before .+ is at least the simple average of the sixty seconds of CF Benchmarks' \1 before/i;
export const ruleOk=(rules?:string)=>!!rules&&RULE.test(rules);
export interface CryptoPrice {coin:Coin;spot:number;strike:number;tau:number;sigma:number;model:number;kalshi:number|null;p:number}
export type CryptoResult=CryptoPrice|{coin:Coin;error:string};
export class CryptoPricer {
  private feeds=new Map<Coin,ProxyFeed>();
  constructor(private log:(e:string,d:unknown)=>void){}
  /** Starts a coin's four price feeds the first time a position in its series is seen; they keep running after that. */
  want(series:string){const coin=CRYPTO15[series];if(!coin||this.feeds.has(coin))return;const f=new ProxyFeed((e,d)=>this.log('crypto-'+e,{coin,...(d as object)}),coin);f.start();this.feeds.set(coin,f);this.log('crypto-feed-start',{coin});}
  tick(nowMs:number){const time=Math.floor(nowMs/1000)*1000;for(const f of this.feeds.values())f.sample(time);}
  price(q:Quote,nowMs:number):CryptoResult|null{
    const coin=CRYPTO15[q.seriesTicker];if(!coin)return null;
    if(!ruleOk(q.rules))return {coin,error:'its settlement rule is not the Bitcoin 15-minute one, so the model does not price it'};
    const f=this.feeds.get(coin);if(!f)return {coin,error:'price feeds starting'};
    const time=Math.floor(nowMs/1000)*1000,last=f.history.at(-1),close=q.closeTime,strike=q.strike;
    if(!last||time-last.time>3000)return {coin,error:'no live spot price'};
    if(close===null||strike==null||!(strike>0))return {coin,error:'Kalshi has not published the opening price yet'};
    const tau=(close-time)/1000;if(tau<=0)return {coin,error:'round closed'};
    const vol=volatility(f.history);if(vol.count<120||!(vol.sigma>0))return {coin,error:`model warming up (${vol.count}/120 s of prices)`};
    const locked=tau<=60?filledSeconds(f.history,close-60000,time)?.values??null:[];if(locked===null)return {coin,error:'gap in the final-minute prices'};
    const model=probability(last.price,strike,vol.sigma,tau,locked,0).p;
    const kalshi=q.yesBid!==null&&q.yesAsk!==null&&q.yesAsk-q.yesBid<=.1?(q.yesBid+q.yesAsk)/2:null;
    const p=predict(priorFit(),{modelP:model,mid:kalshi,sigma:vol.sigma,momentum30s:null,momentum120s:null,imbalance:null,tradeFlow30s:null}).p;
    return {coin,spot:last.price,strike,tau,sigma:vol.sigma,model,kalshi,p};
  }
}
