import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {version}=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
const base='https://line-home-ai.kitworks.workers.dev';
let health;
let status;
for(let attempt=0;attempt<12;attempt++) {
  try {
    const response=await fetch(base+'/health',{signal:AbortSignal.timeout(10000),cache:'no-store'});
    status=response.status;
    const body=await response.json();
    if(response.ok&&body.version===version&&body.ready===true&&body.storage?.backend==='d1'&&body.storage?.ready===true&&body.storage?.r2Required===false) { health=body;break; }
  } catch { /* Allow bounded deployment propagation, without echoing responses or secrets. */ }
  if(attempt<11)await new Promise(resolve=>setTimeout(resolve,5000));
}
assert.ok(health,`Production version ${version} failed readiness check (HTTP ${status??'unavailable'})`);
const rejected=await fetch(base+'/webhook',{method:'POST',headers:{'content-type':'application/json','x-line-signature':'synthetic-invalid-signature'},body:'{"events":[]}',signal:AbortSignal.timeout(10000)});
assert.equal(rejected.status,401,'Unsigned webhook must be rejected');
await rejected.arrayBuffer();
const missing=await fetch(base+'/synthetic-nonexistent-test-route',{signal:AbortSignal.timeout(10000)});
assert.equal(missing.status,404,'No public diagnostic/admin route is added');
await missing.arrayBuffer();
const result={version:health.version,httpStatus:status,ready:health.ready,storage:health.storage,invalidSignatureStatus:401,unknownRouteStatus:404};
console.log(JSON.stringify(result,null,2));
await fs.mkdir('production-http-artifact',{recursive:true});
await fs.writeFile('production-http-artifact/result.json',JSON.stringify(result,null,2)+'\n');
