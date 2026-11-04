'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {createApp}=require('./server.cjs'),{JsonStore}=require('./json-store.cjs'),{RedisStore}=require('./redis-store.cjs');
test('Serverless configuration never silently falls back to local JSON',async()=>{
 await assert.rejects(createApp({serverless:true,store:new JsonStore(':memory:'),secret:'short',origin:'https://app.example'}),/AUTH_SECRET/);
 assert.throws(()=>new RedisStore({url:'http://insecure.example',token:'test'}),/HTTPS/);
});
test('Independent serverless instances share CSRF, async accounts, sessions, and progress',async()=>{
 const memory=new JsonStore(':memory:');
 // Every operation becomes asynchronous, matching a remote database adapter.
 const store=new Proxy(memory,{get(target,key){const value=target[key];return typeof value==='function'?async(...args)=>{await Promise.resolve();return value.apply(target,args);}:value;}});
 const settings={serverless:true,production:false,origin:'http://app.example',secret:crypto.randomBytes(32).toString('hex'),store};
 const apps=await Promise.all([createApp(settings),createApp(settings)]);
 await Promise.all(apps.map(app=>new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve))));
 const cookies=new Map();let csrf;
 async function request(instance,route,method='GET',body,origin='http://app.example'){
  const headers={Host:'app.example',Cookie:[...cookies].map(([key,value])=>key+'='+value).join('; ')};
  if(method==='POST')Object.assign(headers,{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf});
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:apps[instance].server.address().port,path:route,method,headers},res=>{let raw='';for(const cookie of res.headers['set-cookie']||[]){const pair=cookie.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 }
 try{
  csrf=(await request(0,'/api/auth/session')).data.csrfToken;
  const credentials={name:'Cloud Parent',email:'cloud@example.test',password:'Cloud-test-password-42',age:9,'age-unit':'months','hearing-age':3,'hearing-age-unit':'months'};
  const signup=await request(1,'/api/auth/signup','POST',credentials);assert.equal(signup.status,201);
  assert.equal((await request(0,'/api/auth/session')).data.user.email,credentials.email);
  assert.equal((await request(0,'/api/auth/signup','POST',credentials)).status,409);
  const event={ownerId:signup.data.user.id,eventId:crypto.randomUUID(),stage:1,sound:'coo'};
  assert.equal((await request(0,'/api/progress','POST',event)).data.progress.unique,1);
  assert.equal((await request(1,'/api/progress','POST',event)).data.progress.plays,1);
  assert.equal((await request(0,'/api/progress','POST',event,'https://outside.example')).status,403);
  assert.equal((await request(1,'/api/auth/logout','POST',{})).status,200);
  assert.equal((await request(0,'/api/auth/session')).data.user,null);
  assert.equal((await request(1,'/api/auth/login','POST',credentials)).status,200);
 }finally{await Promise.all(apps.map(app=>app.close()));}
});
test('Upstash REST adapter keeps tokens private and reports connection failures',async()=>{
 const commands=[];
 const store=new RedisStore({url:'https://redis.example',token:'private-token',fetch:async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer private-token');commands.push(JSON.parse(options.body));return {ok:true,json:async()=>({result:1})};}});
 await store.addUser({id:'user-id',email:'test@example.test'});
 assert.equal(commands[0][0],'EVAL');assert.equal(commands[0][2],2);
 await store.addEvent({user_id:'user-id',event_id:'event-id',stage:1,sound_key:'coo'});assert.equal(commands[1][0],'HSETNX');
 const unavailable=new RedisStore({url:'https://redis.example',token:'private-token',fetch:async()=>({ok:false})});
 await assert.rejects(unavailable.userById('id'),error=>error.status===503&&!error.message.includes('private-token'));
});
test('Vercel pre-parsed JSON request bodies work with secure cookies',async()=>{
 const app=await createApp({serverless:true,store:new JsonStore(':memory:'),secret:'stable-test-secret-with-32-characters',origin:'https://app.example'});
 function request(url,body,cookies,csrf){return new Promise(resolve=>{
  const headers={host:'app.example','content-type':'application/json',origin:'https://app.example',cookie:cookies,'x-csrf-token':csrf};
  const responseHeaders={};const res={headersSent:false,setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},getHeader(k){return responseHeaders[k.toLowerCase()];},writeHead(status,extra){this.status=status;this.headersSent=true;Object.assign(responseHeaders,extra);},end(raw){resolve({status:this.status,headers:responseHeaders,data:JSON.parse(raw)});}};
  app.handler({url,method:body?'POST':'GET',headers,body,socket:{}},res);
 });}
 const bootstrap=await request('/api/auth/session');const cookie=bootstrap.headers['set-cookie'].map(value=>value.split(';')[0]).join('; ');
 assert(bootstrap.headers['set-cookie'][0].includes('; Secure'));
 assert(bootstrap.headers['set-cookie'][0].startsWith('__Host-'));
 const signup=await request('/api/auth/signup',{name:'Parsed Body',email:'parsed@example.test',password:'Parsed-password-42',age:1,'age-unit':'years','hearing-age':3,'hearing-age-unit':'months'},cookie,bootstrap.data.csrfToken);
 assert.equal(signup.status,201);
});
test('Production and exact Vercel deployment hosts support accounts while unrelated hosts and origins are rejected',async()=>{
 const keys=['VERCEL_URL','VERCEL_BRANCH_URL'];
 const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  process.env.VERCEL_URL='hearnest-build-team.vercel.app';
  process.env.VERCEL_BRANCH_URL='hearnest-git-main-team.vercel.app';
  const app=await createApp({serverless:true,store:new JsonStore(':memory:'),secret:'stable-test-secret-with-32-characters',origin:'https://app.example'});
  async function request(host,url,body,cookies,csrf,origin='https://'+host){
   let result;const responseHeaders={};
   const res={headersSent:false,setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},getHeader(k){return responseHeaders[k.toLowerCase()];},writeHead(status,extra){this.status=status;this.headersSent=true;Object.assign(responseHeaders,extra);},end(raw){result={status:this.status,headers:responseHeaders,data:JSON.parse(raw)};}};
   await app.handler({url,method:body?'POST':'GET',headers:{host,origin,'content-type':'application/json',cookie:cookies,'x-csrf-token':csrf},body,socket:{}},res);
   return result;
  }
  for(const host of ['app.example',process.env.VERCEL_URL,process.env.VERCEL_BRANCH_URL]){
   const session=await request(host,'/api/auth/session');assert.equal(session.status,200);
   const cookie=session.headers['set-cookie'].map(value=>value.split(';')[0]).join('; ');
   const person={name:'Host Test',email:host+'@example.test',password:'Host-test-password-42',age:9,'age-unit':'months','hearing-age':3,'hearing-age-unit':'months'};
   assert.equal((await request(host,'/api/auth/signup',person,cookie,session.data.csrfToken,'https://outside.example')).status,403);
   assert.equal((await request(host,'/api/auth/signup',person)).status,403);
   assert.equal((await request(host,'/api/auth/signup',person,cookie,session.data.csrfToken)).status,201);
  }
  for(const host of ['unrelated.vercel.app','hearnest-build-team.vercel.app.evil.example'])assert.equal((await request(host,'/api/auth/session')).status,403);
 }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});

test('Static build contains welcome artwork and no private backend files',()=>{
 const root=path.resolve(__dirname,'..'),out=path.join(root,'dist');
 assert(fs.existsSync(path.join(out,'assets','hearnest-reference.jpg')));
 assert(fs.readFileSync(path.join(out,'index.html'),'utf8').includes('src="assets/hearnest-reference.jpg"'));
 for(const name of ['backend','api','scripts','tools','package.json','.env'])assert(!fs.existsSync(path.join(out,name)));
 // Windows accepts case mistakes that fail on Linux. Check every image and button MP3 component exactly.
 for(const page of fs.readdirSync(out).filter(file=>file.endsWith('.html'))){const html=fs.readFileSync(path.join(out,page),'utf8');const sources=[...html.matchAll(/<img\b[^>]*src="([^"]+)"|<button\b[^>]*data-audio="([^"]+)"/g)].map(match=>match[1]||match[2]);for(const source of sources){if(/^(data:|https?:)/.test(source))continue;let location=out;for(const part of decodeURIComponent(source).split('/')){assert(fs.readdirSync(location).includes(part),'Missing/case mismatch '+page+': '+source);location=path.join(location,part);}}}
});

// Regression coverage for the configuration failures seen on the live deployment.
test('Vercel KV aliases work and startup errors identify settings without exposing values',async()=>{
 const keys=['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','KV_REST_API_URL','KV_REST_API_TOKEN','AUTH_SECRET'];
 const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const entryPath=require.resolve('../api/index.js');
 try{
  for(const key of keys)delete process.env[key];
  delete require.cache[entryPath];
  let response;
  const res={headersSent:false,writeHead(status){this.status=status;this.headersSent=true;},end(raw){response=JSON.parse(raw);}};
  const previous=console.error;console.error=()=>{};
  try{await require(entryPath)({url:'/api/index?route=auth/session'},res);}finally{console.error=previous;}
  assert.equal(res.status,503);assert.equal(response.code,'MISSING_REDIS_CONFIG');assert.equal(response.missing.length,2);
  process.env.KV_REST_API_URL='https://redis.example';process.env.KV_REST_API_TOKEN='secret-test-token';
  const redis=new RedisStore();assert.equal(redis.url,'https://redis.example');assert.equal(redis.token,'secret-test-token');
  assert.throws(()=>new RedisStore({url:'a bad private URL',token:'private-value'}),error=>error.code==='INVALID_REDIS_URL'&&!error.message.includes('private-value'));
  await assert.rejects(createApp({serverless:true,store:new JsonStore(':memory:'),origin:'https://app.example'}),error=>error.code==='INVALID_AUTH_SECRET');
  const app=await createApp({serverless:true,store:new JsonStore(':memory:'),secret:'stable-secret-with-over-32-characters',origin:'https://hearnest-learn.vercel.app/'});
  // A dashboard URL with a trailing slash is normalized to an origin.
  assert.equal(typeof app.handler,'function');
 }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}delete require.cache[entryPath];}
});
