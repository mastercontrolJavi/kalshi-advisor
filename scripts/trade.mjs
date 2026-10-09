import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {mkdirSync,appendFileSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));process.chdir(root);mkdirSync('logs',{recursive:true});
const log=(event,data={})=>{const message=JSON.stringify({time:new Date().toISOString(),event,...data});console.log(message);appendFileSync('logs/launcher.log',message+'\n');};
let stopping=false;const children=new Set();const timers=new Set();
function child(args,options={}){const p=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});children.add(p);p.on('exit',()=>children.delete(p));return p;}
function run(args){return new Promise((resolve,reject)=>{const p=child(args);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`Command failed (${code}): ${args[0]}`)));});}
let awake;
if(process.platform==='win32'){awake=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts','keep-awake.ps1'),'-ParentProcessId',String(process.pid)],{stdio:'inherit',windowsHide:true});children.add(awake);}
else if(process.platform==='darwin'){awake=spawn('caffeinate',['-dimsu','-w',String(process.pid)],{stdio:'inherit'});children.add(awake);}
else {awake=spawn('systemd-inhibit',['--what=sleep','--mode=block','--why=Kalshi advisor running','--who=kalshi-advisor','sleep','infinity'],{stdio:'inherit'});children.add(awake);}
awake.on('error',e=>log('keep-awake-unavailable',{message:e.message}));awake.on('exit',code=>{children.delete(awake);if(!stopping&&code)log('keep-awake-stopped',{code});});
const stop=()=>{if(stopping)return;stopping=true;for(const timer of timers)clearTimeout(timer);for(const p of children)p.kill('SIGTERM');setTimeout(()=>process.exit(0),1000).unref();};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
function supervise(name,args){let crashes=0;const start=()=>{if(stopping)return;const began=Date.now(),p=child(args);log('process-start',{name,pid:p.pid});p.on('error',e=>log('process-error',{name,message:e.message}));p.on('exit',code=>{if(stopping)return;crashes=Date.now()-began>60000?0:crashes+1;const delay=Math.min(30000,1000*2**Math.min(crashes,5));log('process-restart',{name,code,delay});const timer=setTimeout(()=>{timers.delete(timer);start();},delay);timers.add(timer);});};start();}
try{await run(['node_modules/vitest/vitest.mjs','run']);await run(['node_modules/typescript/bin/tsc','--noEmit']);await run(['node_modules/next/dist/bin/next','build']);if(!stopping){supervise('engine',['--import','tsx','src/engine/index.ts']);supervise('web',['--import','tsx','scripts/web.ts']);supervise('markets',['--import','tsx','src/markets/index.ts']);}}
catch(e){log('startup-failed',{message:e.message});stop();process.exitCode=1;}
