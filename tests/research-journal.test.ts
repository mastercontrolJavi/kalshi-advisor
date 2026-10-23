import {afterEach,describe,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {ResearchJournal,researchScores,type ResearchForecast} from '../src/engine/quant/research-journal';
import {baseFees} from '../src/engine/model/fees';
const databases:Database.Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function setup(max=10000){const db=new Database(':memory:');databases.push(db);db.exec('CREATE TABLE outcomes(ticker TEXT PRIMARY KEY,time INTEGER,result TEXT)');return {db,journal:new ResearchJournal(db,max)};}
function forecast(time=100000,ticker='BTC-1'):ResearchForecast{return {brtiP:.7,marketP:.6,quantP:.61,calibratedP:.6,candidateP:.68,sourceTime:time+100,exchangeTime:time+500,clockOffset:500,closeTime:time+30000,tau:30,fees:baseFees,book:{ticker,time,bookUpdated:time-20,valid:true,delayMs:20,yes:[[.59,5]],no:[[.39,5]]},input:{},calibration:{},flow:{}};}
describe('prospective research recorder',()=>{
 it('keeps checkpoints immutable and rejects post-outcome capture',()=>{
  const {db,journal}=setup();expect(journal.capture('BTC-1',100000,forecast())).toBe(true);
  expect(journal.capture('BTC-1',100000,{...forecast(),candidateP:.99})).toBe(false);
  expect(JSON.parse((db.prepare('SELECT context FROM research_forecasts').get() as any).context).candidateP).toBe(.68);
  db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('BTC-2',90000,'yes');
  expect(journal.capture('BTC-2',100000,forecast(100000,'BTC-2'))).toBe(false);
 });
 it('rejects future/stale official observations, clock mismatch and future books',()=>{
  const {journal}=setup(),f=forecast();
  for(const patch of [{sourceTime:100501},{sourceTime:97000},{exchangeTime:101000},{tau:20},{book:{...f.book,time:100001}},{candidateP:NaN},{closeTime:99999}])expect(journal.capture('BTC-1',100000,{...f,...patch})).toBe(false);
 });
 it('records raw event overflow explicitly and deduplicates normalized events',()=>{
  const {db,journal}=setup(1),e={sessionId:'session',ordinal:1,sourceTime:900,receivedAt:1000};
  journal.enqueue(e);journal.enqueue({...e,ordinal:2});journal.flush(1000);journal.enqueue(e);journal.flush(1001);
  expect((db.prepare('SELECT count(*) n FROM microstructure_events').get() as any).n).toBe(1);
  expect((db.prepare('SELECT count FROM research_gaps').get() as any).count).toBe(1);
  expect(journal.stats.droppedEvents).toBe(1);expect(journal.stats.events).toBe(1);
 });
 it('uses paired score masks and only outcomes available by evaluation time',()=>{
  const {db,journal}=setup();journal.capture('BTC-1',100000,forecast());journal.capture('BTC-2',101000,{...forecast(101000,'BTC-2'),candidateP:null});
  db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('BTC-1',140500,'yes');db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('BTC-2',140500,'no');
  expect(researchScores(db,139999).find(r=>r.horizon===30)?.pending).toBe(2);
  const rows=researchScores(db,140000).find(r=>r.horizon===30)!.models;
  expect(rows.find(r=>r.model==='brtiP')?.n).toBe(2);expect(rows.find(r=>r.model==='candidateP')?.n).toBe(1);
  expect(rows.find(r=>r.model==='candidateP')?.marketBrier).toBeCloseTo(.16);
 });
 it('keeps invalid book snapshots to prevent replay from silently skipping an outage',()=>{
  const {db,journal}=setup(),book={...forecast().book,valid:false};journal.book(book,{source:'stream',clockOffset:500,depthLimit:20});
  expect(JSON.parse((db.prepare('SELECT context FROM research_books').get() as any).context).valid).toBe(false);
 });
});
