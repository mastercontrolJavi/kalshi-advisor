import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {executionStudy,executionStudyMarkdown} from '../src/engine/quant/execution-study';
export {executionStudy,executionStudyMarkdown} from '../src/engine/quant/execution-study';

if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  const args=process.argv.slice(2),arg=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  const dbPath=resolve(arg('--db')??(args[0]&&!args[0].startsWith('--')?args[0]:process.env.ADVISOR_DB??'data/advisor.db'));
  const through=arg('--through'),asOf=through===undefined?Date.now():/^\d+$/.test(through)?Number(through):Date.parse(through);
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{db.pragma('query_only = ON');db.pragma('busy_timeout = 5000');const report=db.transaction(()=>executionStudy(db,asOf,{oneSided:true}))(),output=resolve('output/EXECUTION-STUDY.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');writeFileSync(resolve('output/EXECUTION-STUDY.md'),executionStudyMarkdown(report));console.log(JSON.stringify({status:report.status,asOf:report.asOf,checkpoints:report.checkpoints,snapshotRowsRead:report.snapshotRowsRead,output},null,2));}finally{db.close();}
}
