const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const path = require('node:path');
const factory = require('occt-import-js');
const dir = __dirname;
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const near = (actual, expected, tolerance, label) => assert(Math.abs(actual-expected)<=tolerance, `${label}: ${actual} vs ${expected}`);
(async () => {
  const occt = await factory({ wasmBinary: fs.readFileSync(require.resolve('occt-import-js/dist/occt-import-js.wasm')) });
  const summaries = [];
  for (const role of ['baseline', 'candidate']) {
    const raw = fs.readFileSync(path.join(dir, `${role}-preview.json`));
    const bundle = JSON.parse(raw);
    const bytes = Buffer.from(bundle.step.base64, 'base64');
    assert.equal(bytes.length, bundle.step.bytes); assert.equal(digest(bytes), bundle.step.sha256);
    const model = occt.ReadStepFile(bytes, {linearUnit:'millimeter', linearDeflectionType:'bounding_box_ratio', linearDeflection:0.0025, angularDeflection:0.35});
    assert.equal(model.success, true); assert.equal(model.meshes.length, 2, 'exactly two component meshes');
    const meshes = model.meshes.map(mesh => {
      const p=mesh.attributes.position.array, idx=mesh.index.array;
      const min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity];
      for(let i=0;i<p.length;i+=3) for(let a=0;a<3;a++) { assert(Number.isFinite(p[i+a])); min[a]=Math.min(min[a],p[i+a]);max[a]=Math.max(max[a],p[i+a]); }
      let volume=0;
      for(let i=0;i<idx.length;i+=3) {
        const a=idx[i]*3,b=idx[i+1]*3,c=idx[i+2]*3;
        volume+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;
      }
      return {name:mesh.name,vertices:p.length/3,triangles:idx.length/3,min,max,size:max.map((v,i)=>v-min[i]),center:max.map((v,i)=>(v+min[i])/2),tessellatedVolumeMm3:Math.abs(volume)};
    }).sort((a,b)=>a.center[0]-b.center[0]);
    meshes.forEach((mesh,index)=>{
      const depth=index===1?8:role==='baseline'?5:8;
      near(mesh.center[0], index*40, 0.2, 'component X center');near(mesh.center[1],0,0.2,'component Y center');
      near(mesh.min[2],0,0.001,'bottom datum');near(mesh.size[2],depth,0.001,'depth');
      near(mesh.size[0],20,0.2,'diameter X');near(mesh.size[1],20,0.2,'diameter Y');
      near(mesh.tessellatedVolumeMm3,Math.PI*100*depth,Math.PI*100*depth*0.03,'tessellated volume within 3 percent');
    });
    fs.writeFileSync(path.join(dir,`${role}.step`),bytes);
    summaries.push({role,bundleSha256:digest(raw),stepSha256:digest(bytes),bytes:bytes.length,meshes});
  }
  near(summaries[1].meshes[0].size[2]-summaries[0].meshes[0].size[2],3,0.001,'target depth difference');
  assert.deepEqual(summaries[0].meshes[1].min,summaries[1].meshes[1].min);assert.deepEqual(summaries[0].meshes[1].max,summaries[1].meshes[1].max);
  near(summaries[0].meshes[1].tessellatedVolumeMm3,summaries[1].meshes[1].tessellatedVolumeMm3,0.000001,'unchanged companion');
  const report={checkedAt:new Date().toISOString(),parser:'occt-import-js 0.0.23',units:'mm',depthToleranceMm:0.001,meshDiameterAndCenterToleranceMm:0.2,tessellatedVolumeRelativeTolerance:0.03,verdict:'pass',summaries};
  fs.writeFileSync(path.join(dir,'real-step-geometry.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
