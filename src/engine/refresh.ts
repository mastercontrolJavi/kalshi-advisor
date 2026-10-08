import {spawn,type ChildProcess} from 'node:child_process';
import {mkdirSync,openSync,closeSync,statSync} from 'node:fs';
import {constants,setPriority} from 'node:os';
import {VERDICT_PATH} from '../backtest/verdict';
/**
 * Keeps the backtest current without anyone running it: once the verdict is a day old, the engine starts
 * `scripts/backtest.ts` as a separate, below-normal-priority process (so it can never stall the engine loop). It
 * downloads only the new history, re-runs the replay and the final-minute study, and rewrites
 * data/backtest-verdict.json, which the engine already hot-reloads. The report goes to output/BACKTEST.md (git-ignored);
 * docs/BACKTEST.md stays the committed snapshot.
 */
export const REFRESH_EVERY_MS=24*3600000,RETRY_MS=3600000,STARTUP_GRACE_MS=10*60000;
export function refreshDue(verdictMtime:number|null,now:number,o:{running:boolean;lastAttempt:number;started:number}){
  if(o.running||now-o.started<STARTUP_GRACE_MS||now-o.lastAttempt<RETRY_MS)return false;
  return verdictMtime===null||now-verdictMtime>=REFRESH_EVERY_MS;
}
export class BacktestRefresher {
  running=false;lastAttempt=0;lastExit:number|null=null;lastFinished=0;private child:ChildProcess|null=null;
  constructor(private log:(event:string,data:unknown)=>void,private started=Date.now()){}
  tick(now=Date.now()){
    let mtime:number|null=null;try{mtime=statSync(VERDICT_PATH).mtimeMs;}catch{}
    if(refreshDue(mtime,now,{running:this.running,lastAttempt:this.lastAttempt,started:this.started}))this.start();
  }
  start(){
    this.running=true;this.lastAttempt=Date.now();mkdirSync('logs',{recursive:true});const out=openSync('logs/backtest.log','a');
    try{
      const child=spawn(process.execPath,['--import','tsx','scripts/backtest.ts','--out','output/BACKTEST.md'],{cwd:process.cwd(),stdio:['ignore',out,out],windowsHide:true});
      this.child=child;try{if(child.pid)setPriority(child.pid,constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
      this.log('backtest-refresh-started',{pid:child.pid});
      child.on('exit',code=>{this.running=false;this.child=null;this.lastExit=code;this.lastFinished=Date.now();this.log('backtest-refresh-finished',{code});});
      child.on('error',e=>{this.running=false;this.child=null;this.log('backtest-refresh-error',{message:e.message});});
    }catch(e){this.running=false;this.log('backtest-refresh-error',{message:(e as Error).message});}
    finally{closeSync(out);}
  }
  stop(){this.child?.kill();}
}
