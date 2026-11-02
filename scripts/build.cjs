'use strict';
// Publish only HTML and media. Private backend data and source never enter dist.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist');
if(path.dirname(out)!==root)throw Error('Invalid output directory');
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
const {stageForPage}=require('../backend/stage-access.cjs');
for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.html'))){
 const stage=stageForPage(name);
 // Later age-protected lessons need server routing before they can be published.
 if(stage>3)throw Error('Add authenticated server routing before deploying '+name);
 const html=fs.readFileSync(path.join(root,name),'utf8');
 for(const match of html.matchAll(/<img\b[^>]*src="([^"]+)"/g)){
  if(/^(https?:|data:)/.test(match[1]))continue;
  const asset=decodeURIComponent(match[1].split('?')[0]);
  if(!fs.existsSync(path.join(root,asset)))throw Error('Missing image in '+name+': '+asset);
 }
 fs.copyFileSync(path.join(root,name),path.join(out,name));
}
function copyMedia(directory,relative='assets'){
 for(const item of fs.readdirSync(directory,{withFileTypes:true})){
  const from=path.join(directory,item.name),to=path.join(relative,item.name);
  if(item.isSymbolicLink())throw Error('Asset symlinks are not allowed');
  if(item.isDirectory())copyMedia(from,to);
  else if(/\.(mp3|png|jpe?g|svg|webp|ico|woff2?)$/i.test(item.name)){
   fs.mkdirSync(path.dirname(path.join(out,to)),{recursive:true});fs.copyFileSync(from,path.join(out,to));
  }
 }
}
copyMedia(path.join(root,'assets'));
console.log('Built public HTML and media in dist. Private accounts and backend source excluded.');
