// 只在控制器核对的专用旧系统AVD中验证本包系统DNS辅助进程，账本只读。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";
const networkTest=process.argv[4]==="--network";
assert.ok((process.argv.length===4 || (process.argv.length===5 && networkTest)) && process.argv[2]==="--port", "Usage: check-android-dns-worker.mjs --port PORT [--network]");
const page = await connectProbe(process.argv[3]);
const state = "window.__dnsWorker";
const report = {scenario:networkTest?"dns-worker-network":"dns-worker",cases:{}};
async function control(path="state", post=false) {
  const response = await fetch(`http://127.0.0.1:18517/${path}`,{method:post?"POST":"GET",signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200); return response.json();
}
async function observed(test) {
  for (let i=0;i<100;i++) { const value=await control(); if (test(value)) return value; await delay(25); }
  throw Error("DNS worker fixture condition not observed");
}
async function start(transport="dns-valid", resolver="os-worker", immediate=false, mode="normal") {
  const id=`worker_${crypto.randomUUID()}`;
  report.inFlight={requestId:id};
  await page.evaluate(`(async () => {
    ${state}.events[${JSON.stringify(id)}]=[];
    await ${state}.stream.start({requestId:${JSON.stringify(id)},transport:${JSON.stringify(transport)},resolver:${JSON.stringify(resolver)},mode:${JSON.stringify(mode)}});
    ${immediate?`await ${state}.stream.cancel({requestId:${JSON.stringify(id)}});`:""}
  })()`);
  return id;
}
async function finished(id,type,detail="",allowHttp=false) {
  const events=await page.until(`${state}.events[${JSON.stringify(id)}].some(e=>e.type!=='chunk')?${state}.events[${JSON.stringify(id)}]:null`,9000);
  report.inFlight.events=events;
  assert.equal(events.filter(e=>e.type!=="chunk").length,1);
  assert.equal(events.at(-1).type,type,JSON.stringify(events)); assert.equal(events.at(-1).data,detail);
  const resources=await page.evaluate(`${state}.stream.resources()`);
  report.inFlight.resources=resources;
  assert.equal(resources.active,false);
  for(const key of ["workers","resolutions","dnsSockets","httpCalls","connections","networkWatches","dnsWorkerBindings","dnsWorkerPid"]) assert.equal(resources[key],0,key);
  const fixture=await observed(value=>value.dnsWorkerPids.length===0 && value.probeOwnedSockets===0);
  report.inFlight.fixture=fixture;
  assert.equal(fixture.mainPid,report.mainPid,"Main app process changed");
  const response=await fetch(`http://127.0.0.1:18510/observations?requestId=${id}`,{signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
  const observation=await response.json();
  report.inFlight.observation=observation;
  if(type==="done") {
    assert.equal(observation.authorized,true);
    assert.equal(observation.fixtureHost,"valid.p0-dns.invalid:18511");
    assert.equal(observation.fixtureSni,"valid.p0-dns.invalid");
    assert.deepEqual(events.filter(e=>e.type==="chunk").map(e=>JSON.parse(e.data).text),["旅途1","旅途2","旅途3"]);
    assert.ok(events.at(-1).dnsWorkerPidUsed>0);
    assert.notEqual(String(events.at(-1).dnsWorkerPidUsed),report.mainPid);
  } else if(allowHttp) assert.equal(observation.authorized,true);
  else assert.equal(observation,null,"DNS/TLS failure reached HTTP");
  return {events,resources,fixture,observation};
}
try {
  await page.until("document.getElementById('runtime').textContent==='Android原生桥已就绪'");
  await page.evaluate(`(async () => {
    const api=await import('./capacitor-core.js');
    if(api.Capacitor.getPlatform()!=='android') throw Error('Not native Android');
    ${state}={stream:api.registerPlugin('ProbeAsyncStream'),store:api.registerPlugin('ProbeStore'),credentials:api.registerPlugin('ProbeStream'),events:{}};
    ${state}.listener=await ${state}.stream.addListener('stream',event=>{const events=${state}.events[event.requestId];if(events)events.push(event);});
  })()`);
  assert.equal((await page.evaluate(`${state}.stream.resources()`)).resolver,"minidns-core-owned-io","Legacy platform required");
  report.mainPid=(await control()).mainPid;
  assert.ok(/^\d+$/.test(report.mainPid));
  report.before=await page.evaluate(`${state}.store.read()`);
  await page.evaluate(`${state}.credentials.prepareCredentialFixture()`);
  await control("mode/direct",true);
  report.cases.valid=await finished(await start(),"done");
  if(networkTest) {
    async function network(available) {
      return page.until(`(async()=>{const r=await ${state}.stream.resources();return Boolean(r.currentNetwork)===${available}?r:null;})()`,15000);
    }
    async function restoredNetwork() {
      const end=Date.now()+15000;
      let name="",since=Date.now();
      while(Date.now()<end) {
        const r=await page.evaluate(`${state}.stream.resources()`);
        if(!r.currentNetwork || r.currentNetwork!==name) {name=r.currentNetwork;since=Date.now();}
        else if(Date.now()-since>=750) return r;
        await delay(50);
      }
      throw Error("No stable network after restore");
    }
    for(const phase of ["dns","reading"]) {
      await control("mode/direct",true);
      const initial=await restoredNetwork();
      const id=await start(phase==="dns"?"dns":"dns-valid","os-worker",false,phase==="reading"?"stall":"normal");
      if(phase==="reading") await page.until(`${state}.events[${JSON.stringify(id)}].some(e=>e.type==='chunk')`);
      const live=await observed(value=>phase==="dns"?value.dns.held>0 && value.dnsWorkerPids.length===1:value.probeOwnedSockets>0);
      const active=await page.evaluate(`${state}.stream.resources()`);
      assert.equal(active.boundNetwork,initial.currentNetwork);
      assert.equal(active.networkWatches,1);
      if(phase==="dns") {assert.ok(live.dns.heldNames.includes(active.dnsHost));assert.equal(active.dnsWorkerBindings,1);assert.equal(String(active.dnsWorkerPid),live.dnsWorkerPids[0]);}
      else {assert.equal(active.dnsWorkerBindings,0);assert.deepEqual(live.dnsWorkerPids,[]);}
      report.inFlight.live={fixture:live,resources:active};
      const stopped=Date.now();
      await control("network/off",true);
      await network(false);
      const result=await finished(id,"error","NETWORK_LOST",phase==="reading");
      result.afterSwitchMs=Date.now()-stopped;
      assert.ok(result.afterSwitchMs<3000);
      const terminal=result.events.at(-1);
      assert.ok(terminal.networkLostMs>=0);
      result.callbackToTerminalMs=terminal.elapsedMs-terminal.networkLostMs;
      assert.ok(result.callbackToTerminalMs>=0 && result.callbackToTerminalMs<1000);
      report.cases[phase]={...result,initial,live,active};
      report.cases[`${phase}-offline`]=await finished(await start(),"error","NETWORK_UNAVAILABLE");
      assert.deepEqual(await page.evaluate(`${state}.store.read()`),report.before);
      await control("network/restore",true);
      const restored=await restoredNetwork();
      assert.notEqual(restored.currentNetwork,initial.currentNetwork);
      if(phase==="dns") assert.ok((await control()).dns.heldNames.includes(active.dnsHost),"Old DNS was released before new request");
      report.cases[`${phase}-recovered`]=await finished(await start(),"done");
      assert.equal(report.cases[`${phase}-recovered`].events.at(-1).boundNetwork,restored.currentNetwork);
      if(phase==="dns") assert.notEqual(String(report.cases[`${phase}-recovered`].events.at(-1).dnsWorkerPidUsed),live.dnsWorkerPids[0]);
      await control("release",true);
    }
  } else {
    for(const kind of ["cancel","deadline","worker-death"]) {
      await control("mode/direct",true);
      const id=await start("dns");
      const live=await observed(value=>value.dns.held>0 && value.dnsWorkerPids.length===1);
      const active=await page.evaluate(`${state}.stream.resources()`);
      assert.equal(active.dnsWorkerBindings,1);
      assert.equal(String(active.dnsWorkerPid),live.dnsWorkerPids[0]);
      report.inFlight.live={fixture:live,resources:active};
      const stopped=Date.now();
      if(kind==="cancel") await page.evaluate(`${state}.stream.cancel({requestId:${JSON.stringify(id)}})`);
      if(kind==="worker-death") report.inFlight.injected=await control("worker-exit",true);
      const result=await finished(id,kind==="cancel"?"cancelled":"error",kind==="cancel"?"":kind==="deadline"?"DEADLINE":"DNS_FAILED");
      result.afterStopMs=Date.now()-stopped;
      if(kind==="cancel") assert.ok(result.afterStopMs<1000);
      if(kind==="deadline") assert.ok(result.events.at(-1).elapsedMs>=5900 && result.events.at(-1).elapsedMs<7000);
      result.live=live;
      report.cases[kind]=result;
      // 旧系统服务的DNS仍未释放时，新显式请求必须能使用新辅助工作。
      report.cases[`${kind}-reuse`]=await finished(await start(),"done");
      assert.notEqual(String(report.cases[`${kind}-reuse`].events.at(-1).dnsWorkerPidUsed),live.dnsWorkerPids[0]);
      await control("release",true);
    }
    const binding=await start("dns","os-worker-bind-delay");
    await page.until(`(async()=>{const r=await ${state}.stream.resources();return r.dnsWorkerBindings===1 && r.dnsWorkerPid===0;})()`);
    const stopped=Date.now();
    await page.evaluate(`${state}.stream.cancel({requestId:${JSON.stringify(binding)}})`);
    report.cases.bindingCancelled=await finished(binding,"cancelled");
    report.cases.bindingCancelled.afterStopMs=Date.now()-stopped;
    assert.ok(report.cases.bindingCancelled.afterStopMs<1500);
    for(let i=0;i<3;i++) report.cases[`immediate-${i}`]=await finished(await start("dns","os-worker",true),"cancelled");
    for(const certificate of ["hostname","untrusted","expired"]) report.cases[certificate]=await finished(await start(`dns-${certificate}`),"error","TLS_FAILED");
  }
  await delay(300);
  for(const result of Object.values(report.cases)) {
    const id=result.events[0].requestId;
    assert.deepEqual(await page.evaluate(`${state}.events[${JSON.stringify(id)}]`),result.events,"Late worker event");
  }
  const final=await control();
  assert.deepEqual(final.dnsWorkerPids,[],"Worker process restarted after unbind");
  assert.equal(final.mainPid,report.mainPid);
  report.local=await page.evaluate(`${state}.store.read()`);
  assert.deepEqual(report.local,report.before,"DNS worker check changed ledger");
  delete report.inFlight;
  report.fixtureAssertionsPassed=true;
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  if (report.inFlight?.requestId) {
    try { report.inFlight.events=await page.evaluate(`${state}.events[${JSON.stringify(report.inFlight.requestId)}]`); } catch { report.inFlight.eventsUnavailable=true; }
    try { report.inFlight.resources=await page.evaluate(`${state}.stream.resources()`); } catch { report.inFlight.resourcesUnavailable=true; }
    try { report.inFlight.fixture=await control(); } catch { report.inFlight.fixtureUnavailable=true; }
  }
  report.fixtureAssertionsPassed=false;
  console.log(JSON.stringify(report,null,2));
  throw error;
} finally {
  if(networkTest) await control("network/restore",true);
  await page.evaluate(`(async()=>{if(${state}?.listener)await ${state}.listener.remove();})()`);
  page.close();
}
