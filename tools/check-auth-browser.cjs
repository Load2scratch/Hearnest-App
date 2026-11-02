// Headless Edge checks for layout overflow, touch controls, and MP3 decoding.
// No dependencies are needed: Node 24 provides HTTP, fetch, and WebSocket.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),{spawn}=require('node:child_process');
const root=process.cwd();
const pages=fs.readdirSync(root).filter(name=>name.endsWith('.html'));
const sizes=[[320,568],[768,1024],[1024,768],[812,375]];
const artifacts=path.join(root,'tools','responsive-preview');fs.mkdirSync(artifacts,{recursive:true});
let server, app;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 app=await require('../backend/server.cjs').createApp({dataPath:':memory:'}); server=app.server;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'hearnest-layout-'));
 const edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let socket;
 try{
  const portFile=path.join(profile,'DevToolsActivePort');
  for(let i=0;i<120&&!fs.existsSync(portFile);i++)await delay(100);
  if(!fs.existsSync(portFile))throw Error('Headless Edge did not expose its debugging endpoint');
  const debugPort=fs.readFileSync(portFile,'utf8').split('\n')[0];
  const tabs=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target=tabs.find(tab=>tab.type==='page');socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let id=0;const pending=new Map(),events=new Map();
  socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error(JSON.stringify(message.error))):p.resolve(message.result);}}else{for(const fn of events.get(message.method)||[])fn(message.params);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  await send('Page.enable');await send('Runtime.enable');
  async function navigate(page) {
    const loaded=new Promise(resolve=>{const list=events.get('Page.loadEventFired')||[];const fn=()=>{events.set('Page.loadEventFired',list.filter(item=>item!==fn));resolve();};events.set('Page.loadEventFired',[...list,fn]);});
    await send('Page.navigate',{url:base+'/'+page});await loaded;
  }
  async function until(expression) {
    for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100);}
    throw Error('UI state not reached: '+expression+'; '+await evaluate('document.body.innerText'));
  }
  await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
  await navigate('signup.html');
  const providerButtons=await evaluate(`[...document.querySelectorAll('[data-provider]')].map(b=>({provider:b.dataset.provider,disabled:b.disabled}))`);
  if(providerButtons.length!==2||providerButtons.some(b=>b.disabled))throw Error('Provider controls are still disabled');
  for(const provider of ['google','apple']){
    await evaluate(`document.querySelector('[data-provider="${provider}"]').click()`);
    await until(`document.querySelector('[data-auth-status]').textContent.includes('${provider==='google'?'Google':'Apple'} sign-in is not configured')`);
  }
  await evaluate(`(()=>{const form=document.getElementById('signup-form');for(const [key,value] of Object.entries({name:'Test Parent',email:'ui-parent@example.test',password:'Browser-test-password-42',age:'9','age-unit':'months','hearing-age':'7','hearing-age-unit':'months'}))form.elements.namedItem(key).value=value;form.requestSubmit();})()`);
  await until(`location.pathname==='/home.html'&&document.querySelector('.greeting strong')?.textContent==='Test Parent'`);
  await navigate('settings.html#logout');
  await evaluate(`document.querySelector('[data-logout]').click()`);
  await until(`location.pathname==='/index.html'`);
  await navigate('signup.html');
  const loginLink=await evaluate(`document.querySelector('.login-prompt a').getAttribute('href')`);
  if(loginLink!=='login.html')throw Error('Login link is not connected');
  await evaluate(`document.querySelector('.login-prompt a').click()`);
  await until(`location.pathname==='/login.html'`);
  await evaluate(`document.getElementById('login-email').value='ui-parent@example.test';document.getElementById('login-password').value='wrong-password';document.getElementById('login-form').requestSubmit()`);
  await until(`document.querySelector('[data-auth-status]').textContent.includes('Email or password is incorrect')`);
  await evaluate(`document.getElementById('login-password').value='Browser-test-password-42';document.getElementById('login-form').requestSubmit()`);
  await until(`location.pathname==='/home.html'&&document.querySelector('.greeting strong')?.textContent==='Test Parent'`);
  console.log('Passed browser flows: provider setup feedback, signup, session name, logout, login link, incorrect-password handling, successful login.');
  const failures=[];let checks=0;
  for(const [width,height] of sizes){
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:height});
   for(const page of pages){
    const loaded=new Promise(resolve=>{const list=events.get('Page.loadEventFired')||[];const fn=()=>{events.set('Page.loadEventFired',list.filter(item=>item!==fn));resolve();};events.set('Page.loadEventFired',[...list,fn]);});
    await send('Page.navigate',{url:`${base}/${page}`});await Promise.race([loaded,delay(15000).then(()=>{throw Error('Page load timeout: '+page);})]);
    await evaluate('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
    const layout=await evaluate(`(()=>{
      const width=innerWidth;
      const overflow=[...document.querySelectorAll('a,button,input,select')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&(r.left < -1||r.right > width+1);}).map(el=>({tag:el.tagName,label:(el.textContent||el.id).trim().slice(0,40),left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
      const text=[...document.querySelectorAll('.sound-bubble')].flatMap(el=>{const range=document.createRange();range.selectNodeContents(el);const r=el.getBoundingClientRect(),t=range.getBoundingClientRect();return t.left<r.left+2||t.right>r.right-2?[el.dataset.sound]:[];});
      return {viewport:width,scroll:document.documentElement.scrollWidth,overflow,text};
    })()`);
    if(layout.scroll>layout.viewport+1||layout.overflow.length||layout.text.length)failures.push({page,width,height,...layout});
    if(width===768&&['home.html','settings.html','stage-2.html','signup.html'].includes(page)){
      const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,page.replace('.html','')+'-tablet.png'),Buffer.from(shot.data,'base64'));
    }
    if(width===320&&page==='stage-2.html'){const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'stage-2-phone.png'),Buffer.from(shot.data,'base64'));}
    if(width===768&&page.startsWith('stage-')){
      const audio=await evaluate(`(async()=>{const paths=[...new Set([...document.querySelectorAll('[data-audio]')].map(b=>b.dataset.audio).filter(Boolean))];const context=new AudioContext();const errors=[];for(const path of paths){try{const response=await fetch(path);if(!response.ok)throw Error(response.status);await context.decodeAudioData(await response.arrayBuffer());}catch(e){errors.push({path,error:String(e)});}}await context.close();const slider=document.getElementById('gain-slider');slider.value='80';slider.dispatchEvent(new Event('input'));const gain=document.getElementById('gain-value').value;document.getElementById('mute-button').click();const mute=document.getElementById('gain-value').value;document.getElementById('bell-button').click();return {files:paths.length,errors,gain,mute,bell:document.getElementById('bell-button').classList.contains('is-ringing')};})()`);
      if(audio.errors.length||audio.gain!=='80.0 dB'||audio.mute!=='0.0 dB'||!audio.bell)failures.push({page,width,audio});
      console.log('Audio check:',page,JSON.stringify(audio));
    }
    const missingImages=await evaluate("[...document.images].filter(image=>!image.complete||image.naturalWidth===0).map(image=>image.getAttribute('src'))");
    if(missingImages.length)failures.push({page,width,height,missingImages});
    checks++;
   }
   console.log(`Checked ${pages.length} pages at ${width}x${height}`);
  }
  fs.writeFileSync(path.join(artifacts,'auth-results.json'),JSON.stringify({checks,failures},null,2));
  console.log(JSON.stringify({checks,failures},null,2));
  if(failures.length)process.exitCode=1;
  await send('Browser.close').catch(()=>{});
 }finally{socket?.close();edge.kill();await app.close();}
})().catch(error=>{console.error(error);server?.close();process.exitCode=1;});