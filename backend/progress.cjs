'use strict';
const fs=require('node:fs'),path=require('node:path');
function catalogFor(root){
 const catalog={};
 for(const stage of [1,2,3]){
  const page=fs.readFileSync(path.join(root,`stage-${stage}.html`),'utf8');
  catalog[stage]=[...new Set([...page.matchAll(/data-sound="([^"]+)"/g)].map(match=>match[1]))];
 }
 return catalog;
}
function summarize(rows,catalog){
 const completed={},stagePlays={};let plays=0,lastActivity=null;
 for(const stage of Object.keys(catalog)){completed[stage]=[];stagePlays[stage]=0;}
 for(const row of rows){
  if(!catalog[row.stage]?.includes(row.sound_key))continue;
  completed[row.stage].push(row.sound_key);stagePlays[row.stage]+=row.plays;plays+=row.plays;
  lastActivity=Math.max(lastActivity||0,row.last_completed);
 }
 const total=Object.values(catalog).reduce((sum,keys)=>sum+keys.length,0);
 const unique=Object.values(completed).reduce((sum,keys)=>sum+keys.length,0);
 const finished=Object.keys(catalog).filter(stage=>catalog[stage].length&&completed[stage].length===catalog[stage].length).length;
 return {completed,stagePlays,plays,lastActivity,unique,total,replays:Math.max(0,plays-unique),completedStages:finished,learningPercent:total?Math.round(unique/total*100):0,gamesPercent:Math.round(finished/Object.keys(catalog).length*100),videosPercent:0};
}
module.exports={catalogFor,summarize};