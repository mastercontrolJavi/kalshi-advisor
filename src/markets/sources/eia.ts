/**
 * EIA (free key, EIA_API_KEY): WTI and Brent spot (daily) and US regular gasoline (weekly), shown as context on oil and gas
 * markets. Kalshi's WTI markets settle on the NYMEX front-month settlement and its gas markets on AAA, so EIA is the same
 * neighbourhood, not the settlement price: it never becomes a probability and never drives a verdict or a flag.
 * The key goes to this host only.
 */
export const EIA_HOST='https://api.eia.gov';
export interface EiaPrice {name:string;value:number;period:string;unit:string}
export type FetchRes=(url:string)=>Promise<{status:number;body:any}>;
const SERIES=[{name:'WTI spot',route:'petroleum/pri/spt',series:'RWTC',freq:'daily',unit:'$/bbl'},{name:'Brent spot',route:'petroleum/pri/spt',series:'RBRTE',freq:'daily',unit:'$/bbl'},
  {name:'US regular gasoline',route:'petroleum/pri/gnd',series:'EMM_EPMR_PTE_NUS_DPG',freq:'weekly',unit:'$/gal'}] as const;
export async function eiaPrices(fetchRes:FetchRes,key:string):Promise<EiaPrice[]>{
  const out:EiaPrice[]=[];
  for(const s of SERIES){
    const r=await fetchRes(`${EIA_HOST}/v2/${s.route}/data/?api_key=${encodeURIComponent(key)}&frequency=${s.freq}&data[0]=value&facets[series][]=${s.series}&sort[0][column]=period&sort[0][direction]=desc&length=1`);
    if(r.status===401||r.status===403)throw new Error('EIA key rejected');if(r.status!==200)throw new Error(`EIA HTTP ${r.status}`);
    const row=r.body?.response?.data?.[0],v=Number(row?.value);if(row&&Number.isFinite(v))out.push({name:s.name,value:v,period:String(row.period),unit:s.unit});
  }
  return out;
}
/** Which EIA price is context for a Kalshi series: oil for WTI/Brent/crude series, gasoline for gas series; null otherwise. */
export function eiaFor(series:string):string|null{return /^KX(WTI|OIL|CRUDE)/.test(series)?'WTI spot':/^KX(BRENT)/.test(series)?'Brent spot':/^KX(AAAGAS|GAS|RBOB)/.test(series)?'US regular gasoline':null;}
