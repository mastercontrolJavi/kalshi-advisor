import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3';
/**
 * WAL checkpoints off the engine thread (2026-11-04). SQLite's auto-checkpoint runs inside whichever commit pushes the WAL
 * past 1,000 pages, synchronously: it copies ~4 MB back into the 6 GB journal and syncs it. On the live engine that landed
 * in the 4 Hz loop every 15–25 s as a 37–75 ms callback (4 of the 5 largest loop spikes in a 4-minute capture sat within
 * half a second of a WAL reset, against a 5.5% chance), and in the BRTI/Kalshi socket handlers the rest of the time.
 * The engine turns auto-checkpoint off on its connection and this thread runs PASSIVE checkpoints on its own connection:
 * PASSIVE never waits on the writer or readers, so the engine keeps committing while pages are copied.
 */
const db=new Database(workerData.path);db.pragma('busy_timeout = 1000');
const every=Number(workerData.everyMs)||5000;
setInterval(()=>{
  const started=performance.now();
  try{const [r]=db.pragma('wal_checkpoint(PASSIVE)') as {busy:number;log:number;checkpointed:number}[];
    parentPort!.postMessage({ms:performance.now()-started,...r});}
  catch(e){parentPort!.postMessage({error:(e as Error).message});}
},every);
parentPort!.on('message',m=>{if(m==='stop'){db.close();process.exit(0);}});
