// Recovery tool: removes the app lock from the Just Zen profile. Run with Just Zen closed:
//   npx electron scripts/reset-app-lock.cjs
const {app,safeStorage}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
app.setName('Just Zen');
app.whenReady().then(async()=>{
 const userData=process.env.HEARTH_DATA || path.join(app.getPath('appData'),'Hearth');
 app.setPath('userData',userData);
 const {createSecureStore}=require(path.join(__dirname,'..','secure-store.cjs'));
 const store=createSecureStore({fs,safeStorage,userData});
 const config=await store.load();
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 await fs.copyFile(store.encryptedPath,store.encryptedPath+'.backup-'+stamp).catch(()=>{});
 const had=Boolean(config.appLock);
 delete config.appLock;delete config.appLockMethod;delete config.lockSalt;delete config.lockHash;
 await store.save(config);
 console.log(had?'App lock removed. Backup kept beside workspace.secure.':'No app lock was set; nothing changed.');
 app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
