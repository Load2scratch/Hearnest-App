'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {JsonStore}=require('./json-store.cjs');
const fixture=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),'hearnest-json-test-')),'accounts.json');
test('JSON preserves account sessions and deduplicated progress across restart',()=>{
 const file=fixture(), store=new JsonStore(file);
 store.addUser({id:'child',email:'parent@example.test',password_hash:'scrypt$test',profile_json:'{}'});
 store.replaceSession(null,{token_hash:'hashed-token',user_id:'child',expires_at:200},100);
 const event={user_id:'child',event_id:'unique-event',stage:1,sound_key:'coo',completed_at:150};
 store.addEvent(event);store.addEvent(event);
 const restored=new JsonStore(file);
 assert.equal(restored.session('hashed-token',100).email,'parent@example.test');
 assert.equal(restored.session('hashed-token',201),null);
 assert.equal(restored.progressRows('child')[0].plays,1);
 assert.equal(restored.progressRows('another-child').length,0);
 assert.throws(()=>restored.addUser({id:'duplicate',email:'parent@example.test'}),/Duplicate email/);
});
test('Invalid JSON never resets existing account data',()=>{
 const file=fixture(), original='{broken account file';fs.writeFileSync(file,original);
 assert.throws(()=>new JsonStore(file));assert.equal(fs.readFileSync(file,'utf8'),original);
 fs.writeFileSync(file,JSON.stringify({version:99,users:[],sessions:[],learning_events:[]}));
 assert.throws(()=>new JsonStore(file),/Invalid account JSON/);
});
test('Failed file replacement preserves previous disk and in-memory state',()=>{
 const file=fixture(), store=new JsonStore(file), before=fs.readFileSync(file,'utf8');
 const rename=fs.renameSync;
 try{fs.renameSync=()=>{throw Error('simulated disk failure');};assert.throws(()=>store.addUser({id:'unsaved',email:'fail@example.test'}),/simulated disk failure/);}
 finally{fs.renameSync=rename;}
 assert.equal(store.data.users.length,0);assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.deepEqual(fs.readdirSync(path.dirname(file)),['accounts.json']);
});
