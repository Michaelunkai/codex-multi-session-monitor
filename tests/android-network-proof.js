'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const adb='C:/Users/micha/AppData/Local/Android/platform-tools/adb.exe';
const serial=process.argv[2];
if(!serial)throw Error('Pass the freshly verified Android transport.');
const call=(args,options={})=>execFileSync(adb,['-s',serial,...args],{windowsHide:true,timeout:20000,...options});
const hardware=call(['shell','getprop','ro.serialno'],{encoding:'utf8'}).trim();
const model=call(['shell','getprop','ro.product.model'],{encoding:'utf8'}).trim();
if(hardware!=='R5CY610XJGV'||model!=='SM-S938B')throw Error('Android identity mismatch.');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config','monitor.json'),'utf8'));
const token=fs.readFileSync(cfg.auth.tokenFile,'utf8').trim();
const cert=new crypto.X509Certificate(fs.readFileSync(cfg.tls.certFile));
const pin=crypto.createHash('sha256').update(cert.publicKey.export({format:'der',type:'spki'})).digest('base64');
function phoneGet(route,stream=false){
 const config=['url = "https://'+cfg.bindHost+':'+cfg.port+route+'"','insecure','pinnedpubkey = "sha256//'+pin+'"',
  'header = "Authorization: Bearer '+token+'"','silent','show-error','fail','connect-timeout = 5','max-time = '+(stream?5:15)].join('\n')+'\n';
 try {return call(['shell','curl','--config','-'],{input:config,encoding:'utf8',stdio:['pipe','pipe','pipe']});}
 catch(error){if(stream&&error.status===28&&error.stdout)return error.stdout;throw error;}
}
const health=JSON.parse(phoneGet('/api/health'));
const snapshot=JSON.parse(phoneGet('/api/snapshot?scope=all'));
const html=phoneGet('/');
const js=phoneGet('/app.js');
const streamFrames=phoneGet('/events',true).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
if(!health.ok||snapshot.scope!=='running-now'||snapshot.displayMode!=='running-only'||!snapshot.sessions.every(session=>session.status==='RUNNING')||!snapshot.sessions.every(session=>Array.isArray(session.liveOutput))||!html.includes('Live wall')||!js.includes('EventSource'))throw Error('Android endpoint checks failed.');
const report={checkedAt:new Date().toISOString(),transport:serial,hardware,model,endpoint:'https://'+cfg.bindHost+':'+cfg.port,
 certificatePublicKeyPinVerified:true,credentialsPassedViaStdin:true,androidHttpHealth:health.ok,runningOnly:snapshot.scope==='running-now'&&snapshot.displayMode==='running-only',runningCards:snapshot.sessions.length,
 distinctIds:new Set(snapshot.sessions.map(s=>s.id)).size,statusCounts:snapshot.summary.statusCounts,htmlBytes:html.length,jsBytes:js.length,
 androidStreamFrames:streamFrames.length,androidStreamChanged:streamFrames.length>1,
 visualVerification:false,reason:'Phone network path verified; Android browser UI navigation is outside the active Windows-only browser-control contract.'};
fs.writeFileSync(path.join(root,'logs','android-network-proof.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
