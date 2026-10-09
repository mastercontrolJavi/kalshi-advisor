import {spawn,type ChildProcess} from 'node:child_process';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import {constants,setPriority} from 'node:os';
import {refreshDue} from '../engine/refresh';
import type {MarketsJournal} from './journal';
/**
 * Keeps the Record tab's history current: once the last backfill is a day old (never in the first 10 minutes after start,
 * at most one attempt an hour), runs scripts/markets-backfill.ts as a separate below-normal-priority process, like the
 * Bitcoin backtest refresh. Output goes to logs/markets-backfill.log.
 */
export class BackfillRefresher {
  running=false;lastAttempt=0;private child:ChildProcess|null=null;
  constructor(private log:(event:string,data:unknown)=>void,private journal:MarketsJournal,private started=Date.now()){}
  tick(now=Date.now()){if(refreshDue(this.journal.get<number|null>('backfillFinished',null),now,{running:this.running,lastAttempt:this.lastAttempt,started:this.started}))this.start();}
  start(){
    this.running=true;this.lastAttempt=Date.now();mkdirSync('logs',{recursive:true});const out=openSync('logs/markets-backfill.log','a');
    try{
      const child=spawn(process.execPath,['--import','tsx','scripts/markets-backfill.ts'],{cwd:process.cwd(),stdio:['ignore',out,out],windowsHide:true});
      this.child=child;try{if(child.pid)setPriority(child.pid,constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
      this.log('backfill-started',{pid:child.pid});
      child.on('exit',code=>{this.running=false;this.child=null;this.log('backfill-finished',{code});});
      child.on('error',e=>{this.running=false;this.child=null;this.log('backfill-error',{message:e.message});});
    }catch(e){this.running=false;this.log('backfill-error',{message:(e as Error).message});}
    finally{closeSync(out);}
  }
  stop(){this.child?.kill();}
}
