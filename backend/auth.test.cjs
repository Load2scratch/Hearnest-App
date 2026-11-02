'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('./server.cjs');

test('Authentication API, persistence, and security boundaries',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hearnest-auth-test-'));
 const dataPath=path.join(directory,'accounts.json');
 let app=await createApp({dataPath});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 let base=`http://127.0.0.1:${app.server.address().port}`;
 const jar=new Map();let csrf;
 const person={name:'Test Parent',email:'parent@example.test',password:'Local-test-password-42',age:'9','age-unit':'months','hearing-age':'3','hearing-age-unit':'months'};
 async function request(route,method='GET',body,extra={}){
  const headers={Cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; ')};
  if(method!=='GET')Object.assign(headers,{'Content-Type':'application/json',Origin:base,'X-CSRF-Token':csrf});
  Object.assign(headers,extra);
  const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';');const pos=pair.indexOf('=');jar.set(pair.slice(0,pos),pair.slice(pos+1));}
  const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text();
  return {response,data};
 }
 try{
  await t.test('session bootstrap and HttpOnly CSRF cookie',async()=>{
   const {response,data}=await request('/api/auth/session');assert.equal(response.status,200);assert.equal(data.user,null);csrf=data.csrfToken;assert(csrf);assert(response.headers.get('set-cookie').includes('HttpOnly'));assert(response.headers.get('set-cookie').includes('SameSite=Lax'));
  });
  await t.test('CSRF and origin checks',async()=>{
   assert.equal((await request('/api/auth/signup','POST',person,{'X-CSRF-Token':'wrong'})).response.status,403);
   assert.equal((await request('/api/auth/signup','POST',person,{Origin:'https://outside.example'})).response.status,403);
   assert.equal(app.store.data.users.length,0);
  });
  await t.test('validation rejects invalid age and short password',async()=>{
   assert.equal((await request('/api/auth/signup','POST',{...person,age:'-1'})).response.status,400);
   assert.equal((await request('/api/auth/signup','POST',{...person,password:'short'})).response.status,400);
  });
  await t.test('real sign-up stores hashed credentials and profile',async()=>{
   const {response,data}=await request('/api/auth/signup','POST',person);assert.equal(response.status,201);assert.equal(data.user.name,person.name);assert.equal(data.user.profile.age.unit,'months');assert(!('password_hash'in data.user));
   const stored=app.store.data.users[0];assert(stored.password_hash.startsWith('scrypt$'));assert(!stored.password_hash.includes(person.password));
   const cookie=jar.get('hearnest_session');assert(cookie);const storedSession=app.store.data.sessions[0];assert.notEqual(storedSession.token_hash,cookie);
  });
  await t.test('account session and duplicate email',async()=>{
   assert.equal((await request('/api/auth/session')).data.user.email,person.email);
   assert.equal((await request('/api/auth/signup','POST',person)).response.status,409);
  });
  await t.test('provider buttons report unconfigured services',async()=>{
   for(const name of ['google','apple']){const result=await request(`/api/auth/${name}`,'POST',{});assert.equal(result.response.status,503);assert(result.data.error.includes('not configured'));}
  });
  await t.test('logout revokes the session and clears the cookie',async()=>{
   const result=await request('/api/auth/logout','POST',{});assert.equal(result.response.status,200);assert(result.response.headers.get('set-cookie').includes('Max-Age=0'));assert.equal((await request('/api/auth/session')).data.user,null);assert.equal(app.store.data.sessions.length,0);
  });
  await t.test('wrong password and successful case-insensitive login',async()=>{
   assert.equal((await request('/api/auth/login','POST',{email:person.email,password:'wrong-password'})).response.status,401);
   assert.equal((await request('/api/auth/login','POST',{email:person.email.toUpperCase(),password:person.password})).response.status,200);
  });
  await t.test('session expiry is enforced',async()=>{
   app.store.update(data => data.sessions.forEach(session => { session.expires_at = 0; }));assert.equal((await request('/api/auth/session')).data.user,null);
  });
  await t.test('private backend files blocked; audio ranges supported',async()=>{
   for(const route of ['/backend/server.cjs','/backend/data/hearnest.json','/.env','/tools/check-responsive.cjs','/package.json'])assert.equal((await request(route)).response.status,404);
   const page=await request('/login.html');assert.equal(page.response.status,200);
   assert(page.data.includes('<style data-source="styles.css">'));
   assert(page.data.includes('<script data-source="auth.js">'));
   assert(!/<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"/i.test(page.data));
   const policy=page.response.headers.get('content-security-policy');
   assert(/script-src 'self' 'sha256-/.test(policy));
   assert(/style-src 'self' 'sha256-/.test(policy));
   assert(!policy.includes("'unsafe-inline'"));
   const result=await fetch(base+'/assets/maa.mp3',{headers:{Range:'bytes=0-15'}});assert.equal(result.status,206);assert.equal((await result.arrayBuffer()).byteLength,16);
  });
  await t.test('accounts survive server restart',async()=>{
   await app.close();app=await createApp({dataPath});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
   csrf=(await request('/api/auth/session')).data.csrfToken;
   assert.equal((await request('/api/auth/login','POST',{email:person.email,password:person.password})).response.status,200);
  });
 }finally{await app.close();}
});

test('Authentication attempts are rate limited',async()=>{
 const app=await createApp({dataPath:':memory:',rateLimit:2});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${app.server.address().port}`;const session=await fetch(base+'/api/auth/session');const csrf=(await session.json()).csrfToken;
  const cookie=session.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  for(let i=0;i<3;i++){const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({email:'nobody@example.test',password:'example-password'})});assert.equal(response.status,i===2?429:401);}
 }finally{await app.close();}
});