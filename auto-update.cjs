const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');

function startAutoUpdates(notify=()=>{}){
 if(!app.isPackaged)return {enabled:false,reason:'development'};
 if(!fs.existsSync(path.join(process.resourcesPath,'app-update.yml')))return {enabled:false,reason:'no-release-feed'};
 let autoUpdater;
 try{({autoUpdater}=require('electron-updater'));}catch(error){return {enabled:false,reason:error.message};}
 autoUpdater.autoDownload=true;
 autoUpdater.autoInstallOnAppQuit=true;
 autoUpdater.allowPrerelease=false;
 autoUpdater.allowDowngrade=false;
 autoUpdater.on('update-available',info=>notify(`Just Zen ${info.version} is downloading…`));
 autoUpdater.on('update-downloaded',info=>notify(`Just Zen ${info.version} is ready and will install when you quit.`));
 autoUpdater.on('error',error=>console.warn('Update check failed:',error.message));
 const check=()=>autoUpdater.checkForUpdatesAndNotify().catch(error=>console.warn('Update check failed:',error.message));
 const startup=setTimeout(check,15_000);
 const interval=setInterval(check,6*60*60*1000);
 interval.unref?.();startup.unref?.();
 return {enabled:true,check,dispose(){clearTimeout(startup);clearInterval(interval);}};
}
module.exports={startAutoUpdates};
