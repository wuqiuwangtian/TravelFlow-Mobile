// 严格Private DNS使用固定引导域与本地握手停顿；仅验证拒绝及恢复，不冒充DoT支持。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";
assert.ok(process.argv.length===4 && process.argv[2]==="--port","Usage: check-android-private-dns.mjs --port PORT");
const page=await connectProbe(process.argv[3]);
const state="window.__privateDns";
const report={scenario:"dns-private-dns",cases:{}};
async function control(path="state",post=false) {
  const response=await fetch(`http://127.0.0.1:18517/${path}`,{method:post?"POST":"GET",signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200); return response.json();
}
async function handshakes() {const response=await fetch("http://127.0.0.1:18510/handshakes?requestId=private_dns_probe",{signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);return response.json();}
async function observed(test) {
  const end=Date.now()+15000;
  while(Date.now()<end) {const value=await control();if(test(value))return value;await delay(50);}
  throw Error("Private DNS fixture state not observed");
}
async function start(transport="dns-valid") {
  const id=`private_dns_${crypto.randomUUID()}`;
  report.inFlight={requestId:id};
  await page.evaluate(`(async()=>{${state}.events[${JSON.stringify(id)}]=[];await ${state}.stream.start({requestId:${JSON.stringify(id)},transport:${JSON.stringify(transport)}});})()`);
  return id;
}
async function finished(id,detail="") {
  const events=await page.until(`${state}.events[${JSON.stringify(id)}].some(e=>e.type!=='chunk')?${state}.events[${JSON.stringify(id)}]:null`);
  report.inFlight.events=events;
  assert.equal(events.filter(e=>e.type!=="chunk").length,1);
  assert.equal(events.at(-1).type,detail?"error":"done");assert.equal(events.at(-1).data,detail);
  const resources=await page.evaluate(`${state}.stream.resources()`);report.inFlight.resources=resources;
  assert.equal(resources.active,false);
  for(const key of ["workers","resolutions","dnsSockets","httpCalls","connections","networkWatches","dnsWorkerBindings","dnsWorkerPid"])assert.equal(resources[key],0,key);
  const fixture=await observed(v=>v.probeOwnedSockets===0 && v.dnsWorkerPids.length===0);report.inFlight.fixture=fixture;
  assert.equal(fixture.mainPid,report.mainPid);
  const observation=await (await fetch(`http://127.0.0.1:18510/observations?requestId=${id}`,{signal:AbortSignal.timeout(3000)})).json();
  if(detail) {assert.equal(observation,null);assert.equal(resources.currentPrivateDnsStrict,true);}
  else {
    assert.equal(observation.authorized,true);assert.equal(observation.fixtureHost,"valid.p0-dns.invalid:18511");assert.equal(observation.fixtureSni,"valid.p0-dns.invalid");
    assert.deepEqual(events.filter(e=>e.type==="chunk").map(e=>JSON.parse(e.data).text),["旅途1","旅途2","旅途3"]);
  }
  return {events,resources,fixture,observation};
}
try {
  await page.until("document.getElementById('runtime').textContent==='Android原生桥已就绪'");
  await page.evaluate(`(async()=>{const api=await import('./capacitor-core.js');if(api.Capacitor.getPlatform()!=='android')throw Error('Not Android');${state}={stream:api.registerPlugin('ProbeAsyncStream'),store:api.registerPlugin('ProbeStore'),credentials:api.registerPlugin('ProbeStream'),events:{}};${state}.listener=await ${state}.stream.addListener('stream',e=>{const list=${state}.events[e.requestId];if(list)list.push(e);});})()`);
  report.mainPid=(await control()).mainPid;assert.ok(/^\d+$/.test(report.mainPid));
  report.before=await page.evaluate(`${state}.store.read()`);
  report.original=(await control()).privateDns;
  await page.evaluate(`${state}.credentials.prepareCredentialFixture()`);
  report.cases.baseline=await finished(await start());
  await control("mode/direct",true);
  const priorSequence=Math.max(0,...(await handshakes()).map(v=>v.sequence));
  await control("private-dns/on",true);
  report.strict=await page.until(`(async()=>{const r=await ${state}.stream.resources();return r.currentNetwork && r.currentPrivateDnsStrict?r:null;})()`,15000);
  // 严格配置已由真实LinkProperties确认；引导／TLS是否启动单独记录，不冒充成功DoT。
  await delay(500);
  report.bootstrap=await control();
  report.handshakes=(await handshakes()).filter(v=>v.sequence>priorSequence);
  report.bootstrapObserved=report.bootstrap.dns.queries.some(q=>q.name==="dot.p0-dns.invalid");
  report.dotConnectionObserved=report.bootstrap.dotPackets>0;
  report.encryptedDnsSupportProven=false;
  const applicationQueries=v=>v.dns.queries.filter(q=>q.name!=="dot.p0-dns.invalid");
  const beforeQueries=applicationQueries(await control());
  for(const transport of ["dns-valid","dns","http"])report.cases[transport]=await finished(await start(transport),"PRIVATE_DNS_UNVERIFIED");
  assert.deepEqual(applicationQueries(await control()),beforeQueries,"Rejected request queried plaintext application DNS");
  await control("private-dns/restore",true);
  report.restored=await page.until(`(async()=>{const r=await ${state}.stream.resources();return r.currentNetwork && !r.currentPrivateDnsStrict && !r.currentPrivateDnsActive?r:null;})()`,15000);
  assert.deepEqual((await control()).privateDns,report.original,"Private DNS setting values/existence did not restore");
  report.cases.recovered=await finished(await start());
  await delay(250);
  for(const c of Object.values(report.cases))assert.deepEqual(await page.evaluate(`${state}.events[${JSON.stringify(c.events[0].requestId)}]`),c.events);
  report.local=await page.evaluate(`${state}.store.read()`);assert.deepEqual(report.local,report.before);
  delete report.inFlight;report.fixtureAssertionsPassed=true;console.log(JSON.stringify(report,null,2));
} catch(error) {
  if(report.inFlight?.requestId) {
    try{report.inFlight.events=await page.evaluate(`${state}.events[${JSON.stringify(report.inFlight.requestId)}]`);}catch{report.inFlight.eventsUnavailable=true;}
    try{report.inFlight.resources=await page.evaluate(`${state}.stream.resources()`);}catch{report.inFlight.resourcesUnavailable=true;}
    try{report.inFlight.fixture=await control();}catch{report.inFlight.fixtureUnavailable=true;}
  }
  report.fixtureAssertionsPassed=false;console.log(JSON.stringify(report,null,2));throw error;
} finally {
  await control("private-dns/restore",true);
  await page.evaluate(`(async()=>{if(${state}?.listener)await ${state}.listener.remove();})()`);page.close();
}
