import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {mkdirSync,appendFileSync,readFileSync,rmSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));process.chdir(root);mkdirSync('logs',{recursive:true});
const log=(event,data={})=>{const message=JSON.stringify({time:new Date().toISOString(),event,...data});console.log(message);appendFileSync('logs/launcher.log',message+'\n');};
let stopping=false;const children=new Set();const timers=new Set();
// Edge sidecar (edge/, stdlib Python 3.11+, DECISIONS 75). EDGE_PYTHON overrides the interpreter.
const PYTHON=process.env.EDGE_PYTHON??(process.platform==='win32'?'python':'python3');
// Paper-trading bot (bot/, Python via uv, DECISIONS 81): places no real orders. BOT=off in the environment or .env.local skips it.
const botOff=(process.env.BOT??(()=>{try{return readFileSync('.env.local','utf8').match(/^BOT=(.*)$/m)?.[1];}catch{return undefined;}})())?.trim()==='off';
function child(args,options={},command=process.execPath){const p=spawn(command,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});children.add(p);p.on('exit',()=>children.delete(p));return p;}
// Output is piped through (not inherited) so the tail of a failing step lands in launcher.log: the window it printed to is minimised or gone.
let lastTail='';
function run(args,command){return new Promise((settle,reject)=>{let tail='',done=false;const p=child(args,{stdio:['inherit','pipe','pipe']},command);
  const keep=(sink)=>d=>{sink.write(d);tail=(tail+d.toString()).slice(-4000);};p.stdout.on('data',keep(process.stdout));p.stderr.on('data',keep(process.stderr));
  const end=code=>{if(done)return;done=true;if(code===0)settle();else{lastTail=tail.replace(/\u001b\[[0-9;]*[A-Za-z]/g,'').trim().slice(-1500);reject(new Error(`Command failed (${code}): ${args[0]}`));}};
  p.on('error',e=>{done=true;reject(e);});p.on('close',end);p.on('exit',code=>setTimeout(()=>end(code),2000).unref());});}
let awake;
if(process.platform==='win32'){awake=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts','keep-awake.ps1'),'-ParentProcessId',String(process.pid)],{stdio:'inherit',windowsHide:true});children.add(awake);}
else if(process.platform==='darwin'){awake=spawn('caffeinate',['-dimsu','-w',String(process.pid)],{stdio:'inherit'});children.add(awake);}
else {awake=spawn('systemd-inhibit',['--what=sleep','--mode=block','--why=Kalshi advisor running','--who=kalshi-advisor','sleep','infinity'],{stdio:'inherit'});children.add(awake);}
awake.on('error',e=>log('keep-awake-unavailable',{message:e.message}));awake.on('exit',code=>{children.delete(awake);if(!stopping&&code)log('keep-awake-stopped',{code});});
// On Windows kill() ends only the direct child, which orphans grandchildren (uv's python, next's build workers): kill the tree.
const stop=()=>{if(stopping)return;stopping=true;for(const timer of timers)clearTimeout(timer);for(const p of children){if(process.platform==='win32'&&p.pid)spawnSync('taskkill',['/pid',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else p.kill('SIGTERM');}setTimeout(()=>process.exit(0),1000).unref();};
// SIGHUP/SIGBREAK: closing the console window. Without a handler node dies at once and restarts nothing, but a supervised child that sees the close first exits 3221225786 and would be restarted.
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('SIGHUP',stop);process.on('SIGBREAK',stop);
function supervise(name,args,command){let crashes=0;const start=()=>{if(stopping)return;const began=Date.now(),p=child(args,{},command);log('process-start',{name,pid:p.pid});p.on('error',e=>log('process-error',{name,message:e.message}));p.on('exit',code=>{if(stopping)return;crashes=Date.now()-began>60000?0:crashes+1;const delay=Math.min(30000,1000*2**Math.min(crashes,5));if(code===3221225786){log('console-closed',{name});stop();return;}log('process-restart',{name,code,delay});const timer=setTimeout(()=>{timers.delete(timer);start();},delay);timers.add(timer);});};start();}
// A launch killed mid-build (closed window, Ctrl+C, sleep) leaves webpack's persistent cache corrupt and every later build fails
// (WasmHash ... reading 'length'). The cache is only a speed-up, so on a failed build drop it and build once more from scratch.
async function build(){const args=['node_modules/next/dist/bin/next','build'];try{await run(args);}catch(e){if(stopping)throw e;log('build-retry',{message:e.message,reason:'clearing .next/cache/webpack'});rmSync(resolve(root,process.env.NEXT_DIST_DIR??'.next','cache','webpack'),{recursive:true,force:true});await run(args);}}
// The tests run once more before a failure stops the launch: right after a boot or a wake the machine is busy and a
// timing check can miss (2026-11-15 and 11-18: the app stayed down over one). Broken code fails both runs.
const tests=async()=>{try{await run(['node_modules/vitest/vitest.mjs','run']);}catch(e){if(stopping)throw e;log('tests-retry',{message:e.message});await run(['node_modules/vitest/vitest.mjs','run']);}};
try{await tests();await run(['-m','unittest','discover','-s','edge/tests','-t','.'],PYTHON);await build();await run(['node_modules/typescript/bin/tsc','--noEmit']);if(!stopping){supervise('engine',['--import','tsx','src/engine/index.ts']);supervise('web',['--import','tsx','scripts/web.ts']);supervise('edge',['-m','edge'],PYTHON);if(!botOff)supervise('bot',['run','--project','bot','python','-m','bot','run'],'uv');}}
catch(e){log('startup-failed',{message:e.message,tail:lastTail});if(lastTail)console.error('\n--- last output of the failed step ---\n'+lastTail);stop();process.exitCode=1;}
