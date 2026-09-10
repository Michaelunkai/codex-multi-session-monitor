'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const stopFile = path.join(root, 'data', 'stop.request');
const lockFile = path.join(root, 'data', 'supervisor.lock');
const supervisorPidFile = path.join(root, 'data', 'supervisor.pid.json');
const logFile = path.join(root, 'logs', 'supervisor.log');
const powershell = path.join(root, 'runtime', 'powershell', 'pwsh.exe');
const bridgeScript = path.join(__dirname, 'tailscale.ps1');
const env = { ...process.env, TEMP:path.join(root,'temp'), TMP:path.join(root,'temp'),
  PSModuleAnalysisCachePath:path.join(root,'cache','powershell-analysis'), POWERSHELL_TELEMETRY_OPTOUT:'1',
  XDG_CACHE_HOME:path.join(root,'cache'), NODE_EXTRA_CA_CERTS:path.join(root,'config','tls','server-cert.pem') };
const scriptHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
function log(message) {
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024*1024) fs.renameSync(logFile, logFile+'.previous');
  fs.appendFileSync(logFile, new Date().toISOString()+' '+message.replace(/token=[a-f0-9]+/gi,'token=[redacted]')+'\n');
}
function read(file) { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
function alive(pid) { try { process.kill(pid,0); return true; } catch { return false; } }
function acquire() {
  if(fs.existsSync(lockFile)) {
    const pid=Number(fs.readFileSync(lockFile,'utf8'));
    if(pid && alive(pid)) return false;
    fs.unlinkSync(lockFile);
  }
  try {fs.writeFileSync(lockFile,String(process.pid),{flag:'wx'});return true;} catch{return false;}
}
function writeSupervisorReceipt() {
  fs.writeFileSync(supervisorPidFile, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    scriptPath: __filename,
    scriptHash
  }, null, 2), 'utf8');
}
function health() {
  return new Promise(resolve=>{
    try {
      const cfg=read(path.join(root,'config','monitor.json'));
      const runtime=read(path.join(root,'data','monitor.pid.json'));
      const token=fs.readFileSync(cfg.auth.tokenFile,'utf8').trim();
      const transport=cfg.tls.enabled?https:http;
      const requestOptions={hostname:runtime.bindHost,port:runtime.port,path:'/api/liveness',
        headers:{Authorization:'Bearer '+token},timeout:8000};
      if(cfg.tls.enabled)requestOptions.ca=fs.readFileSync(cfg.tls.certFile);
      const req=transport.get(requestOptions, res=>{
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve(res.statusCode===200&&JSON.parse(text).ok);}catch{resolve(false);}});
      });
      req.on('timeout',()=>{req.destroy();resolve(false);});req.on('error',()=>resolve(false));
    } catch {resolve(false);}
  });
}
function ensureBridge(port) {
  return new Promise(resolve => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-File', bridgeScript,
      '-Action', 'Ensure', '-MonitorPort', String(port)],
      { cwd: root, windowsHide: true, env });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve('bridge check timed out');
    }, 15000);
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { output += data.toString(); });
    child.on('error', error => { clearTimeout(timer); resolve('bridge check error: ' + error.message); });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve('bridge exit ' + code + (output.trim() ? ' ' + output.trim() : ''));
    });
  });
}
function launch() {
  return new Promise(resolve=>{
    const child=spawn(path.join(root,'runtime','powershell','pwsh.exe'),['-NoLogo','-NoProfile','-File',path.join(__dirname,'START.ps1'),'-QuietAccess'],{cwd:root,windowsHide:true,env});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    child.on('error',e=>{log('launch error: '+e.message);resolve();});
    child.on('exit',code=>{log('START exit '+code+' '+output.trim());resolve();});
  });
}
async function main(){
  if(!acquire())return;
  try {
    writeSupervisorReceipt();
    log('Supervisor started '+process.pid);
    // A new Windows logon is a requested automatic start, including after a prior manual STOP.
    if(process.argv.includes('--logon') && fs.existsSync(stopFile))fs.unlinkSync(stopFile);
    let failures=0;
    let nextBridgeCheck=0;
    let lastBridgeResult='';
    while(!fs.existsSync(stopFile)){
      const monitorHealthy=await health();
      if(monitorHealthy){
        failures=0;
        if(Date.now()>=nextBridgeCheck){
          let port=0;
          try { port=Number(read(path.join(root,'data','monitor.pid.json')).port); } catch {}
          if(port){
            const bridgeResult=await ensureBridge(port);
            nextBridgeCheck=Date.now()+30000;
            if(bridgeResult!==lastBridgeResult){ log(bridgeResult); lastBridgeResult=bridgeResult; }
          } else {
            nextBridgeCheck=Date.now()+10000;
          }
        }
      }else{
        failures++;
        if(failures>=2){log('Two health probes failed; recovering monitor.');await launch();failures=0;}
      }
      await new Promise(resolve=>setTimeout(resolve,10000));
    }
    log('Manual STOP observed; supervisor exiting.');
  } finally {
    if(fs.existsSync(supervisorPidFile)) {
      try {
        const receipt = read(supervisorPidFile);
        if(Number(receipt.pid) === process.pid) fs.unlinkSync(supervisorPidFile);
      } catch {}
    }
    if(fs.existsSync(lockFile)&&fs.readFileSync(lockFile,'utf8')===String(process.pid))fs.unlinkSync(lockFile);
  }
}
main().catch(e=>{log(e.stack);process.exitCode=1;});
