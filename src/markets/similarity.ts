import {normTokens} from './teams';
const STOP=new Set(['will','in','be','by','on','to','an','for','before','after','than','more','less','what','who','how','does','do','is','are','this','next','win','yes','no']);
const words=(s:string)=>new Set(normTokens(s).filter(t=>!STOP.has(t)).map(t=>t.length>3&&t.endsWith('s')?t.slice(0,-1):t));
/** Below this a title match is not even suggested. */
export const SUGGEST_MIN=.6;
/** How alike two market titles are: shared words over all words (Jaccard), +0.1 when they share a number (year, threshold). */
export function similarity(a:string,b:string):number{
  const x=words(a),y=words(b);if(!x.size||!y.size)return 0;
  const shared=[...x].filter(t=>y.has(t)),union=new Set([...x,...y]).size;
  return Math.min(1,shared.length/union+(shared.some(t=>/\d/.test(t))?.1:0));
}
