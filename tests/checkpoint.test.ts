import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// 2026-11-04: SQLite's auto-checkpoint ran inside the engine's 4 Hz loop (37–75 ms every 15–25 s). The engine now sets
// wal_autocheckpoint = 0 and checkpoint-worker.ts runs PASSIVE checkpoints on its own connection. This pins the two
// SQLite behaviours that relies on: with auto-checkpoint off the writer never copies pages back itself, and a PASSIVE
// checkpoint from a second connection backfills everything the writer committed while it keeps writing.
it('a second connection checkpoints the writer’s WAL while auto-checkpoint is off',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ckpt-')),path=join(dir,'j.db');
  const writer=new Database(path);writer.pragma('journal_mode = WAL');writer.pragma('synchronous = NORMAL');writer.pragma('wal_autocheckpoint = 0');
  const checkpointer=new Database(path);checkpointer.pragma('busy_timeout = 1000');
  try{
    writer.exec('CREATE TABLE ticks(id INTEGER PRIMARY KEY,context TEXT NOT NULL)');const insert=writer.prepare('INSERT INTO ticks(context) VALUES(?)');
    for(let i=0;i<1500;i++)insert.run('x'.repeat(3900));// ~3,000 WAL pages: past the 1,000 that would trigger an inline checkpoint
    expect(statSync(path+'-wal').size).toBeGreaterThan(1000*4096);// the writer left every page in the WAL
    for(let i=0;i<10;i++)insert.run('y');
    const [r]=checkpointer.pragma('wal_checkpoint(PASSIVE)') as {busy:number;log:number;checkpointed:number}[];
    expect(r.busy).toBe(0);expect(r.checkpointed).toBe(r.log);
    insert.run('after');expect((writer.prepare('SELECT count(*) n FROM ticks').get() as {n:number}).n).toBe(1511);
  }finally{writer.close();checkpointer.close();rmSync(dir,{recursive:true,force:true});}
});
