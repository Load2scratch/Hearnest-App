'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createApp}=require('./server.cjs');
test('Real account activity, unique words, replays, stage completion, and isolation',async t=>{
 const app=await createApp({dataPath:':memory:',rateLimit:100});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${app.server.address().port}`;const jar=new Map();let csrf,owner;
 async function request(route,method='GET',data){const headers={Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')};if(method==='POST')Object.assign(headers,{Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'});const response=await fetch(base+route,{method,headers,body:data?JSON.stringify(data):undefined});for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}return {status:response.status,data:await response.json()};}
 async function signup(email){csrf=(await request('/api/auth/session')).data.csrfToken;const result=await request('/api/auth/signup','POST',{name:'Progress Parent',email,password:'Progress-test-password',age:9,'age-unit':'months','hearing-age':3,'hearing-age-unit':'months'});assert.equal(result.status,201);owner=result.data.user.id;}
 const event=(sound,stage=1,id=crypto.randomUUID())=>({sound,stage,eventId:id,ownerId:owner});
 try{
  await t.test('anonymous activity is not saved to an account',async()=>{const result=await request('/api/progress');assert.equal(result.data.user,null);assert.equal(result.data.progress,null);assert.equal(Object.values(result.data.catalog).flat().length,46);csrf=(await request('/api/auth/session')).data.csrfToken;assert.equal((await request('/api/progress','POST',{sound:'coo',stage:1,eventId:crypto.randomUUID()})).status,401);});
  await signup('progress-a@example.test');
  let firstEvent;
  await t.test('a completed sound increases unique-word and playback counts',async()=>{firstEvent=event('coo');const result=await request('/api/progress','POST',firstEvent);assert.equal(result.status,200);assert.equal(result.data.progress.unique,1);assert.equal(result.data.progress.plays,1);assert.equal(result.data.progress.learningPercent,2);assert.equal(result.data.progress.gamesPercent,0);});
  await t.test('retrying the same event does not double count',async()=>{const result=await request('/api/progress','POST',firstEvent);assert.equal(result.data.progress.plays,1);assert.equal(result.data.progress.unique,1);});
  await t.test('replays increase activity but not the word counter',async()=>{const result=await request('/api/progress','POST',event('coo'));assert.equal(result.data.progress.unique,1);assert.equal(result.data.progress.plays,2);assert.equal(result.data.progress.replays,1);});
  await t.test('invalid sounds and cross-account submissions are rejected',async()=>{assert.equal((await request('/api/progress','POST',event('not-a-sound'))).status,400);assert.equal((await request('/api/progress','POST',{...event('woo'),ownerId:'another-account'})).status,403);});
  await t.test('completing every Stage 1 word updates the Games activity ring',async()=>{const catalog=(await request('/api/progress')).data.catalog;for(const sound of catalog[1].filter(s=>s!=='coo'))assert.equal((await request('/api/progress','POST',event(sound))).status,200);const state=(await request('/api/progress')).data.progress;assert.equal(state.completed[1].length,8);assert.equal(state.unique,8);assert.equal(state.completedStages,1);assert.equal(state.gamesPercent,33);assert.equal(state.videosPercent,0);});
  await t.test('progress stays separate for another signed-in child',async()=>{await signup('progress-b@example.test');const state=(await request('/api/progress')).data.progress;assert.equal(state.unique,0);assert.equal(state.plays,0);assert.equal(state.completedStages,0);});
 }finally{await app.close();}
});