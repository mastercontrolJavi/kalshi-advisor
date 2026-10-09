import type {Group} from './types';
/** The two Bitcoin series have their own pages; Markets covers everything else. */
export const BITCOIN_SERIES=['KXBTC15M','KXBTCD'];
export const seriesOf=(ticker:string)=>ticker.split('-')[0];
export const isBitcoin=(ticker:string)=>BITCOIN_SERIES.includes(seriesOf(ticker));
/** Kalshi series category → page group (spec §2). Combos are grouped by structure, whatever their category. */
export function groupOf(category:string|null|undefined,isCombo:boolean):Group{
  if(isCombo)return 'combos';
  if(category==='Sports')return 'sports';
  if(category==='Commodities'||category==='Crypto')return 'commodities';
  return 'politics';
}
