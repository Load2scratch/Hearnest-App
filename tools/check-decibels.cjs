// Tests the real stage scripts with a small DOM/audio fixture.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const make=()=>({value:'',style:{},attributes:{},events:{},classList:{toggle(){},add(){},remove(){}},setAttribute(k,v){this.attributes[k]=v},addEventListener(k,f){(this.events[k]||=[]).push(f)},async emit(k){await Promise.all((this.events[k]||[]).map(f=>f()))},stepUp(){this.value=String(Math.min(Number(this.max),Number(this.value)+.5))},stepDown(){this.value=String(Math.max(Number(this.min),Number(this.value)-.5))}});
(async()=>{let routes=0;
for(const stage of [1,2,3]){
 const html=fs.readFileSync(`stage-${stage}.html`,'utf8');
 const ids=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],make()]));assert(ids.has('gain-value'));
 const buttons=[...html.matchAll(/<button\b[^>]*data-sound="([^"]+)"[^>]*data-audio="([^"]*)"[^>]*>/gs)].map(m=>Object.assign(make(),{dataset:{sound:m[1],audio:m[2]},textContent:m[1]}));
 const slider=ids.get('gain-slider');Object.assign(slider,{value:'96.5',min:'0',max:'100'});
 assert(/id="gain-slider"[\s\S]*?min="0"[\s\S]*?max="100"/.test(html));
 const sources=[],gains=[],recorded=[];
 class AudioContext{constructor(){this.state='running';this.currentTime=0}createGain(){const node={gain:{value:1,cancelScheduledValues(){},setValueAtTime(v){this.value=v},linearRampToValueAtTime(v){this.value=v}},connect(){}};gains.push(node);return node}async decodeAudioData(){return {}}createBufferSource(){const source={connect(node){this.connected=node},disconnect(){},start(){this.started=true},stop(){this.stopped=true}};sources.push(source);return source}}
 const env={window:{location:{protocol:'http:'},AudioContext,HearnestStageAccess:{ready:Promise.resolve({authorized:true})},HearnestProgress:{ready:Promise.resolve(),record:(n,key)=>recorded.push([n,key])},addEventListener(){}},document:{getElementById:id=>{assert(ids.has(id),'Missing '+id);return ids.get(id)},querySelectorAll:()=>buttons,addEventListener(){}},fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(4)}),console,Map,Math,Uint8Array};
 await vm.runInNewContext(html.match(new RegExp('<script data-source="stage-' + stage + '.js">\\n([\\s\\S]*?)\\n    </script>'))[1],env);
 assert.equal(ids.get('gain-value').value,'96.5 dB');
 await buttons[0].emit('click');
 assert(Math.abs(gains[0].gain.value-10**(-3.5/20))<1e-9);
 for(const level of [-10,0,.5,20,50,80,100,150]){
  slider.value=String(level);await slider.emit('input');const bounded=Math.min(100,Math.max(0,level));
  assert.equal(ids.get('gain-value').value,`${bounded.toFixed(1)} dB`);
  assert(Math.abs(gains[0].gain.value-(bounded===0?0:10**((bounded-100)/20)))<1e-9);
  assert(gains[0].gain.value>=0&&gains[0].gain.value<=1);
 }
 slider.value='0';await slider.emit('input');assert(ids.get('gain-decrease').disabled);assert.equal(ids.get('gauge-fill').style.opacity,'0');sources.at(-1).onended();assert.equal(recorded.length,0,'Silent completion must not count');
 slider.value='100';await slider.emit('input');assert(ids.get('gain-increase').disabled);
 await buttons[0].emit('click');sources.at(-1).onended();assert.equal(recorded.length,1);
 slider.value='80';await slider.emit('input');await ids.get('gain-decrease').emit('click');assert.equal(slider.value,'79.5');await ids.get('gain-increase').emit('click');assert.equal(slider.value,'80');
 await ids.get('mute-button').emit('click');assert.equal(ids.get('gain-value').value,'0.0 dB');assert.equal(gains[0].gain.value,0);await ids.get('mute-button').emit('click');assert.equal(ids.get('gain-value').value,'80.0 dB');assert(Math.abs(gains[0].gain.value-.1)<1e-9);
 for(const button of buttons){await button.emit('click');assert.equal(sources.at(-1).connected,gains[0]);routes++;}
 console.log(`Stage ${stage}: 0-100 limits, half-dB buttons, exact silence, mute restore, display/gauge, and shared gain verified.`);
}
console.log(`Passed all ${routes} sound-button routes through the shared 0-100 control.`);
})().catch(error=>{console.error(error);process.exitCode=1});