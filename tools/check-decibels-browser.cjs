// Headless Edge checks for layout overflow, touch controls, and MP3 decoding.
// No dependencies are needed: Node 24 provides HTTP, fetch, and WebSocket.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),{spawn}=require('node:child_process');
const root=process.cwd();
const pages=['stage-1.html','stage-2.html','stage-3.html'];
const sizes=[[320,568],[768,1024]];
const artifacts=path.join(root,'tools','responsive-preview');fs.mkdirSync(artifacts,{recursive:true});
const server=http.createServer((req,res)=>{
 let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));}catch{res.writeHead(400).end();return;}
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mp3':'audio/mpeg','.jpg':'image/jpeg','.png':'image/png'};
 res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
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
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const Native=window.AudioContext;window.__gainNodes=[];window.AudioContext=class extends Native{createGain(){const node=super.createGain();window.__gainNodes.push(node);return node;}};})();`});
  const failures=[];let checks=0;
  for(const [width,height] of sizes){
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:height});
   for(const page of pages){
    const loaded=new Promise(resolve=>{const list=events.get('Page.loadEventFired')||[];const fn=()=>{events.set('Page.loadEventFired',list.filter(item=>item!==fn));resolve();};events.set('Page.loadEventFired',[...list,fn]);});
    await send('Page.navigate',{url:`${base}/${page}`});await Promise.race([loaded,delay(15000).then(()=>{throw Error('Page load timeout: '+page);})]);
    await evaluate('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
    await evaluate('window.HearnestProgress.ready');
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
    const live=await evaluate(`(async()=>{const button=document.querySelector('[data-sound]');if(document.getElementById('mute-button').getAttribute('aria-pressed')==='true')document.getElementById('mute-button').click();button.click();for(let i=0;i<30&&!window.__gainNodes.length;i++)await new Promise(r=>setTimeout(r,25));const context=window.__gainNodes[0].context;await Promise.race([context.resume(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Audio context did not resume')),3000))]);const started=context.currentTime;for(let i=0;i<30&&context.currentTime<started+.05;i++)await new Promise(r=>setTimeout(r,25));const slider=document.getElementById('gain-slider');const checks=[];for(const level of [0,50,80,100]){slider.value=String(level);slider.dispatchEvent(new Event('input'));await new Promise(r=>setTimeout(r,50));checks.push({level,display:document.getElementById('gain-value').value,gain:window.__gainNodes[0].gain.value});}document.getElementById('gain-decrease').click();const half=document.getElementById('gain-value').value;document.getElementById('mute-button').click();await new Promise(r=>setTimeout(r,50));const muted={display:document.getElementById('gain-value').value,gain:window.__gainNodes[0].gain.value};document.getElementById('mute-button').click();const restore=document.getElementById('gain-value').value;button.click();return {checks,half,muted,restore,font:getComputedStyle(document.getElementById('gain-value')).fontSize};})()`);
    for(const check of live.checks){const expected=check.level===0?0:10**((check.level-100)/20);if(check.display!==check.level.toFixed(1)+' dB'||Math.abs(check.gain-expected)>.0001)failures.push({page,width,check});}
    if(live.half!=='99.5 dB'||live.muted.display!=='0.0 dB'||live.muted.gain!==0||live.restore!=='99.5 dB'||live.font!=='30px')failures.push({page,width,live});
    console.log('Native audio gain, zero/mute, 0.5 steps, and readout font checked:',page,width);
    checks++;
   }
   console.log(`Checked ${pages.length} pages at ${width}x${height}`);
  }
  fs.writeFileSync(path.join(artifacts,'decibel-results.json'),JSON.stringify({checks,failures},null,2));
  console.log(JSON.stringify({checks,failures},null,2));
  if(failures.length)process.exitCode=1;
  await send('Browser.close').catch(()=>{});
 }finally{socket?.close();edge.kill();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});