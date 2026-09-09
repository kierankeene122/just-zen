const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {findNode}=require('./node-runtime.cjs');
test('a Node binary bundled in the app resources is preferred over Homebrew',()=>{
 const res=fs.mkdtempSync(path.join(os.tmpdir(),'zen-res-'));const bundled=path.join(res,'node');fs.copyFileSync(process.execPath,bundled);fs.chmodSync(bundled,0o755);
 try{assert.equal(findNode({resourcesPath:res,candidates:['/nonexistent/node']}),bundled);}finally{fs.rmSync(res,{recursive:true,force:true});}
});
test('without a bundled binary the current Node or a known install path is used',()=>{
 const found=findNode({resourcesPath:'/nonexistent',candidates:['/opt/homebrew/bin/node','/usr/local/bin/node']});
 assert.ok(found===process.execPath || found.endsWith('/bin/node'));
});
