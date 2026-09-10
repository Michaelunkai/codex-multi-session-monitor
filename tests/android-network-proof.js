'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const adb='C:/Users/micha/AppData/Local/Android/platform-tools/adb.exe';
const serial=process.argv[2];
if(!serial)throw Error('Pass the freshly verified Android transport.');
const call=(args,options={})=>execFileSync(adb,['-s',serial,...args],{windowsHide:true,timeout:20000,maxBuffer:32*1024*1024,...options});
const hardware=call(['shell','getprop','ro.serialno'],{encoding:'utf8'}).trim();
const model=call(['shell','getprop','ro.product.model'],{encoding:'utf8'}).trim();
if(hardware!=='R5CY610XJGV'||model!=='SM-S938B')throw Error('Android identity mismatch.');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config','monitor.json'),'utf8'));
const token=fs.readFileSync(cfg.auth.tokenFile,'utf8').trim();
const endpoint=(process.env.MONITOR_ANDROID_ENDPOINT||fs.readFileSync(path.join(root,'data','tailscale','public-url.txt'),'utf8')).trim().replace(/\/$/,'');
const endpointUrl=new URL(endpoint);
if(endpointUrl.protocol!=='https:'||!/\.ts\.net$/i.test(endpointUrl.hostname))throw Error('Expected the private HTTPS Funnel endpoint.');
function phoneGet(route,stream=false){
 const config=['url = "'+endpointUrl.origin+route+'"',
  'header = "Authorization: Bearer '+token+'"','silent','show-error','fail','connect-timeout = 5','max-time = '+(stream?5:15)].join('\n')+'\n';
 try {return call(['shell','curl','--config','-'],{input:config,encoding:'utf8',stdio:['pipe','pipe','pipe']});}
 catch(error){
  if(stream&&error.status===28&&error.stdout)return error.stdout;
  const detail=error.stderr?String(error.stderr).trim().slice(-1000):`exit ${error.status??'unknown'}`;
  throw Error(`Android GET ${route} failed: ${detail}`);
 }
}
function phoneTransferStats(route){
 const config=['url = "'+endpointUrl.origin+route+'"',
  'header = "Authorization: Bearer '+token+'"','output = "/dev/null"','write-out = "%{http_code}|%{size_download}"',
  'silent','show-error','fail','connect-timeout = 5','max-time = 20'].join('\n')+'\n';
 try {return call(['shell','curl','--config','-'],{input:config,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
 catch(error){
  const detail=error.stderr?String(error.stderr).trim().slice(-1000):`exit ${error.status??'unknown'}`;
  throw Error(`Android transfer ${route} failed: ${detail}`);
 }
}
const health=JSON.parse(phoneGet('/api/health'));
const fullSnapshotTransfer=phoneTransferStats('/api/snapshot?scope=all');
const [fullSnapshotStatus,fullSnapshotBytesText]=fullSnapshotTransfer.split('|');
const fullSnapshotBytes=Number(fullSnapshotBytesText);
const snapshot=JSON.parse(phoneGet('/api/snapshot?scope=all&compact=1'));
const html=phoneGet('/');
const js=phoneGet('/app.js');
const streamFrames=phoneGet('/events?compact=1',true).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
const directLive=snapshot.sessions.length>0&&snapshot.sessions.every(session=>session.liveTransport==='codex-ipc'&&session.activity?.source==='codex-ipc'&&session.liveOutputCount>0&&session.outputChars>0&&/^[a-f0-9]{64}$/i.test(session.outputDigest||''));
if(!health.ok||fullSnapshotStatus!=='200'||!Number.isFinite(fullSnapshotBytes)||fullSnapshotBytes<=0||snapshot.compact!==true||snapshot.scope!=='running-now'||snapshot.displayMode!=='running-only'||!snapshot.sessions.every(session=>session.status==='RUNNING')||!directLive||!html.includes('Live wall')||!js.includes('EventSource'))throw Error('Android endpoint checks failed.');
const report={checkedAt:new Date().toISOString(),transport:serial,hardware,model,endpoint,
 certificateChainVerifiedByAndroidCurl:true,credentialsPassedViaStdin:true,androidHttpHealth:health.ok,fullSnapshotStatus,fullSnapshotBytes,compactSnapshot:true,runningOnly:snapshot.scope==='running-now'&&snapshot.displayMode==='running-only',directCodexIpc:directLive,runningCards:snapshot.sessions.length,
 distinctIds:new Set(snapshot.sessions.map(s=>s.id)).size,statusCounts:snapshot.summary.statusCounts,htmlBytes:html.length,jsBytes:js.length,
 androidStreamFrames:streamFrames.length,androidStreamChanged:streamFrames.length>1,
 visualVerification:false,reason:'Phone reached the authenticated public HTTPS Funnel; Android browser UI navigation is outside the active Windows-only browser-control contract.'};
fs.writeFileSync(path.join(root,'logs','android-network-proof.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
