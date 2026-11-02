'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {stageAccess,stageForPage}=require('./stage-access.cjs');
const {createApp}=require('./server.cjs');
test('Temporary Stage 1-3 preview override preserves later hearing-age bands',()=>{
 for(const [months,current] of [[0,1],[3.99,1],[4,2],[7,3],[10,4],[13,5],[16,6],[19,7],[30,7]]){
  const access=stageAccess({'hearing-age':{value:months,unit:'months'}},n=>n<=3);
  assert.equal(access.currentStage,current);assert.equal(access.stages.filter(s=>s.unlocked).length,Math.max(3,current));assert(access.stages.slice(0,3).every(s=>s.previewOpen));
 }
 assert.equal(stageAccess({'hearing-age':{value:1,unit:'years'}}).currentStage,4);
 const missing=stageAccess(null);assert(missing.stages.slice(0,3).every(s=>s.unlocked));assert(missing.stages.slice(3).every(s=>!s.unlocked));
});
test('Stage routes identify lesson and instruction files',()=>{for(const [page,n] of [['stage-1.html',1],['Stage-2.html',2],['stage-3.html',3],['instructions.html',1],['instructions-stage-2.html',2]])assert.equal(stageForPage(page),n);assert.equal(stageForPage('home.html'),null);});
test('Stages 1-3 stay open, later stages still require an eligible account',async()=>{
 const app=await createApp({dataPath:':memory:'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 try{const base=`http://127.0.0.1:${app.server.address().port}`;for(const page of ['stage-1.html','stage-2.html','stage-3.html','instructions.html','instructions-stage-2.html'])assert.equal((await fetch(base+'/'+page,{redirect:'manual'})).status,200);assert.equal((await fetch(base+'/stage-4.html',{redirect:'manual'})).status,303);const access=await(await fetch(base+'/api/stages')).json();assert.equal(access.authenticated,false);assert(access.stages.slice(0,3).every(s=>s.unlocked));assert(access.stages.slice(3).every(s=>!s.unlocked));}finally{await app.close();}
});