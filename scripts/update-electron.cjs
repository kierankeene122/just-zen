#!/usr/bin/env node
// Local Electron patch automation. Checks npm for the newest Electron in the current major, installs it,
// rebuilds native modules, runs the unit and smoke tests, packages into a staging folder, and swaps the
// packaged app into place when Just Zen is not running. Newer majors are reported but never auto-applied.
//   node scripts/update-electron.cjs            # daily run (launchd)
//   node scripts/update-electron.cjs --force    # rebuild even when already current
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const root=path.resolve(__dirname,'..');
const outputs=path.resolve(root,'../../outputs');
const appDir=path.join(outputs,'Just Zen-darwin-arm64'),app=path.join(appDir,'Just Zen.app'),previous=path.join(appDir,'Just Zen.app.previous');
const staging=path.join(outputs,'staging'),stagedApp=path.join(staging,'Just Zen-darwin-arm64','Just Zen.app');
const stateDir=path.join(os.homedir(),'Library','Application Support','Hearth'),statePath=path.join(stateDir,'update-state.json');
const logDir=path.join(os.homedir(),'Library','Logs','Just Zen'),logPath=path.join(logDir,'update.log'),lockPath=path.join(logDir,'update.lock');
const force=process.argv.includes('--force');
const env={...process.env,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:'+(process.env.PATH || '')};
fs.mkdirSync(logDir,{recursive:true});
function log(message){const line=`[${new Date().toISOString()}] ${message}`;console.log(line);fs.appendFileSync(logPath,line+'\n');}
function run(cmd,args,options={}){const result=spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024,...options});if(result.status!==0)throw Error(`${cmd} ${args.join(' ')} failed (exit ${result.status}):\n${(result.stderr || result.stdout || '').slice(-3000)}`);return result.stdout || '';}
function notify(body){spawnSync('/usr/bin/osascript',['-e',`display notification ${JSON.stringify(body)} with title "Just Zen updates"`]);}
function readState(){try{return JSON.parse(fs.readFileSync(statePath,'utf8'));}catch{return {};}}
function writeState(patch){fs.mkdirSync(stateDir,{recursive:true});fs.writeFileSync(statePath,JSON.stringify({...readState(),...patch,checkedAt:new Date().toISOString()},null,2));}
function appRunning(){return spawnSync('/usr/bin/pgrep',['-x','Just Zen']).status===0;}
function installedElectron(){return JSON.parse(fs.readFileSync(path.join(root,'node_modules','electron','package.json'),'utf8')).version;}
function builtElectron(target=app){try{return JSON.parse(fs.readFileSync(path.join(target,'Contents','Resources','build-info.json'),'utf8')).electron;}catch{return null;}}
function swapStagedBuild(){
 if(!fs.existsSync(stagedApp))return false;
 if(appRunning()){log('A new build is staged but Just Zen is running; it will be installed on the next run after you quit.');writeState({staged:true,stagedElectron:builtElectron(stagedApp)});notify('A new build is ready. Quit Just Zen to install it.');return false;}
 fs.rmSync(previous,{recursive:true,force:true});
 if(fs.existsSync(app))fs.renameSync(app,previous);
 fs.mkdirSync(appDir,{recursive:true});fs.renameSync(stagedApp,app);fs.rmSync(staging,{recursive:true,force:true});
 const version=builtElectron();log(`Installed new build with Electron ${version} (previous build kept as Just Zen.app.previous).`);
 writeState({staged:false,installedBuild:version,installedAt:new Date().toISOString(),status:'current'});notify(`Just Zen rebuilt with Electron ${version}.`);return true;
}
function latestVersions(current){
 const major=current.split('.')[0];
 const inMajor=JSON.parse(run('npm',['view',`electron@${major}`,'version','--json']) || '[]');
 const latestInMajor=(Array.isArray(inMajor)?inMajor:[inMajor]).filter(v=>/^\d+\.\d+\.\d+$/.test(v)).sort(compare).at(-1);
 const latestOverall=run('npm',['view','electron','version']).trim();
 return {latestInMajor,latestOverall,newerMajor:latestOverall.split('.')[0]!==major?latestOverall:null};
}
function compare(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;}
(async()=>{
 try{fs.writeFileSync(lockPath,String(process.pid),{flag:'wx'});}catch{const age=Date.now()-fs.statSync(lockPath).mtimeMs;if(age<2*60*60*1000){log('Another update run is in progress; exiting.');return;}fs.rmSync(lockPath,{force:true});fs.writeFileSync(lockPath,String(process.pid));}
 let backups=null;
 try{
  swapStagedBuild();
  const current=installedElectron();
  let versions;try{versions=latestVersions(current);}catch(error){log('Could not reach the npm registry: '+error.message.split('\n')[0]);writeState({status:'offline',installed:current});return;}
  const {latestInMajor,latestOverall,newerMajor}=versions;
  log(`Installed Electron ${current}; newest in this major ${latestInMajor}; newest overall ${latestOverall}.`);
  const built=builtElectron();
  const needsBuild=force || compare(latestInMajor,current)>0 || (built && compare(current,built)>0) || !built;
  if(!needsBuild){writeState({status:'current',installed:current,latest:latestInMajor,newerMajor,staged:false});log('Up to date.');return;}
  backups={pkg:fs.readFileSync(path.join(root,'package.json')),lock:fs.readFileSync(path.join(root,'package-lock.json'))};
  if(compare(latestInMajor,current)>0){log(`Installing Electron ${latestInMajor}…`);run('npm',['install','--save-dev','--no-audit','--no-fund',`electron@${latestInMajor}`]);}
  log('Rebuilding native modules…');run('npm',['run','rebuild']);
  log('Running unit tests…');run('npm',['test']);
  log('Running Electron smoke test…');run('npm',['run','smoke']);
  log('Packaging…');fs.rmSync(staging,{recursive:true,force:true});run('node',['scripts/package.cjs'],{env:{...env,ZEN_PACKAGE_OUT:staging}});
  const stagedVersion=builtElectron(stagedApp);log(`Staged build with Electron ${stagedVersion}.`);
  writeState({status:'current',installed:installedElectron(),latest:latestInMajor,newerMajor});
  swapStagedBuild();
 }catch(error){
  log('Update failed: '+error.message);
  if(backups){try{fs.writeFileSync(path.join(root,'package.json'),backups.pkg);fs.writeFileSync(path.join(root,'package-lock.json'),backups.lock);run('npm',['install','--no-audit','--no-fund']);run('npm',['run','rebuild']);log('Restored the previous Electron version.');}catch(restoreError){log('Restore failed: '+restoreError.message);}}
  writeState({status:'failed',error:error.message.split('\n')[0].slice(0,300)});notify('Automatic update failed. See ~/Library/Logs/Just Zen/update.log');process.exitCode=1;
 }finally{fs.rmSync(lockPath,{force:true});}
})();
