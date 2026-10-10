/** Bookmaker odds (decimal) → probabilities without the bookmaker's margin, scaled so they sum to 1. [] for invalid odds. */
export function devig(odds:number[]):number[]{
  if(!odds.length||odds.some(o=>!Number.isFinite(o)||o<=1))return [];
  const implied=odds.map(o=>1/o),sum=implied.reduce((s,x)=>s+x,0);return implied.map(x=>x/sum);
}
const median=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
/** Sportsbook consensus: the median of each outcome across books after removing each book's margin, renormalised. */
export function consensus(books:number[][]):number[]|null{
  const fair=books.map(devig).filter(p=>p.length);if(!fair.length)return null;
  const n=fair[0].length,med=Array.from({length:n},(_,i)=>median(fair.filter(p=>p.length===n).map(p=>p[i]))),sum=med.reduce((s,x)=>s+x,0);
  return med.map(x=>x/sum);
}
