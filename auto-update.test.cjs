const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

// The module reaches for Electron's app, which is not running under the test runner, so it is stubbed
// with the one thing the cache helpers use: a home directory of our own.
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zen-update-'));
require.cache[require.resolve('electron')]={id:require.resolve('electron'),filename:require.resolve('electron'),loaded:true,exports:{app:{getPath:name=>name==='home'?home:home,getVersion:()=>'0.0.0',isPackaged:false}}};
const {clearStaleDownload,clearDownload,pendingDir}=require('./auto-update.cjs');

function partFile(name,ageMs){
  const dir=pendingDir();
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,name);
  fs.writeFileSync(file,'half a download');
  const when=new Date(Date.now()-ageMs);
  fs.utimesSync(file,when,when);
  return file;
}

test('a part-finished download from hours ago is cleared',()=>{
  const old=partFile('temp-Just-Zen-0.5.44-arm64.zip',8*60*60*1000);
  assert.equal(clearStaleDownload(),true);
  assert.equal(fs.existsSync(old),false);
});

test('a download from minutes ago is left alone',()=>{
  const fresh=partFile('temp-Just-Zen-0.5.47-arm64.zip',2*60*1000);
  assert.equal(clearStaleDownload(),false);
  assert.equal(fs.existsSync(fresh),true,'an update still downloading must not be deleted underneath it');
});

test('clearing on demand takes the whole pending folder',()=>{
  partFile('temp-Just-Zen-0.5.47-arm64.zip',0);
  assert.equal(clearDownload(),true);
  assert.equal(fs.existsSync(pendingDir()),false);
});
