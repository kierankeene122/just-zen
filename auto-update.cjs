const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');

// A half-finished download from an earlier version sits in the updater's cache and can break the next one.
// Anything left in "pending" from more than a few hours ago is junk: clearing it costs a fresh download and nothing else.
const CACHE_NAME='just-zen-updater';
function pendingDir(){
  const base=process.platform==='darwin'?path.join(app.getPath('home'),'Library','Caches'):app.getPath('temp');
  return path.join(base,CACHE_NAME,'pending');
}
function clearStaleDownload({olderThanMs=6*60*60*1000}={}){
  const dir=pendingDir();
  let entries=[];
  try{entries=fs.readdirSync(dir);}catch{return false;}
  let cleared=false;
  for(const name of entries){
    const file=path.join(dir,name);
    try{
      const stat=fs.statSync(file);
      if(Date.now()-stat.mtimeMs<olderThanMs)continue;
      fs.rmSync(file,{recursive:true,force:true});
      cleared=true;
    }catch{}
  }
  return cleared;
}
function clearDownload(){
  try{fs.rmSync(pendingDir(),{recursive:true,force:true});return true;}catch{return false;}
}

function startAutoUpdates(notify=()=>{},onReady=()=>{},onState=()=>{}){
 if(!app.isPackaged)return {enabled:false,reason:'development',state:'off'};
 if(!fs.existsSync(path.join(process.resourcesPath,'app-update.yml')))return {enabled:false,reason:'no-release-feed',state:'off'};
 let autoUpdater;
 try{({autoUpdater}=require('electron-updater'));}catch(error){return {enabled:false,reason:error.message,state:'off'};}
 autoUpdater.autoDownload=true;
 autoUpdater.autoInstallOnAppQuit=true;
 autoUpdater.allowPrerelease=false;
 autoUpdater.allowDowngrade=false;
 clearStaleDownload();

 let manual=false,state='idle',lastError='';
 const setState=(next,detail='')=>{state=next;lastError=detail;onState(next,detail);};

 autoUpdater.on('checking-for-update',()=>setState('checking'));
 autoUpdater.on('update-available',info=>{setState('downloading',info.version);notify(`Just Zen ${info.version} is downloading…`);});
 autoUpdater.on('update-not-available',()=>{setState('idle');if(manual)notify(`You're up to date: Just Zen ${app.getVersion()} is the latest.`);manual=false;});
 autoUpdater.on('download-progress',progress=>setState('downloading',Math.round(progress.percent)+'%'));
 autoUpdater.on('update-downloaded',info=>{
   setState('ready',info.version);
   notify(`Just Zen ${info.version} is ready. Restart to update, or it installs the next time you quit.`);
   onReady(info.version);
 });
 // A failed download leaves a part-file behind; clearing it means the next attempt starts clean rather than failing the same way.
 autoUpdater.on('error',error=>{
   const message=String(error && error.message || error).slice(0,160);
   clearDownload();
   setState('failed',message);
   notify('Update failed: '+message+' — it will try again, or use Check for updates.');
   manual=false;
 });

 const check=(byUser=false)=>{
   manual=byUser;
   if(byUser){clearStaleDownload({olderThanMs:0});notify('Checking for updates…');}
   return autoUpdater.checkForUpdatesAndNotify().catch(error=>{
     const message=String(error && error.message || error).slice(0,160);
     console.warn('Update check failed:',message);
     clearDownload();
     setState('failed',message);
     if(byUser)notify('Could not check for updates: '+message);
     manual=false;
   });
 };
 const startup=setTimeout(()=>check(),15_000);
 const interval=setInterval(()=>check(),6*60*60*1000);
 interval.unref?.();startup.unref?.();
 // quitAndInstall closes the app, lets Squirrel swap the bundle, and relaunches, so nobody can reopen the old copy mid-install.
 return {
   enabled:true,
   get state(){return state;},
   get lastError(){return lastError;},
   check:()=>check(false),
   checkNow:()=>check(true),
   retry:()=>{clearDownload();return check(true);},
   install:()=>autoUpdater.quitAndInstall(false,true),
   dispose(){clearTimeout(startup);clearInterval(interval);}
 };
}
module.exports={startAutoUpdates,clearStaleDownload,clearDownload,pendingDir};
