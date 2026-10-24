import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const SCRIPT=fileURLToPath(new URL('../../scripts/full-speed.ps1',import.meta.url));
/**
 * Opt a process out of Windows power throttling (scripts/full-speed.ps1). On battery Windows ran the windowless engine
 * 3.5–7× slower than a foreground process and the Kalshi book fell seconds behind (2026-10-23); this keeps it at full
 * speed. Runs in the background (PowerShell takes ~1 s) and reports through `log`; no-op off Windows.
 */
export function fullSpeed(log:(event:string,data:unknown)=>void,pid=process.pid,platform=process.platform){
  if(platform!=='win32')return false;
  execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',SCRIPT,'-ProcessId',String(pid)],{windowsHide:true,timeout:30000},(e,stdout,stderr)=>{
    const m=/ControlMask=(\d+) StateMask=(\d+)/.exec(stdout);
    log('power-throttling',m&&!e?{ok:m[1]==='1'&&m[2]==='0',pid,controlMask:Number(m[1]),stateMask:Number(m[2])}:{ok:false,pid,message:String(stderr||e?.message||stdout).trim().slice(0,300)});
  });
  return true;
}
