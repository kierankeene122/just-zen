const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile),{profile}=require('./document-helper.cjs');
test('converter sandbox denies unrelated file reads, writes and network',{skip:process.platform!=='darwin'},async()=>{
 const job=await fs.mkdtemp('/private/tmp/zen-isolation-'),outside=await fs.mkdtemp('/private/tmp/zen-private-');
 try{
  await fs.writeFile(outside+'/secret','private');await fs.writeFile(job+'/sandbox.sb',profile(job));
  const code=`const fs=require('fs'),net=require('net');for(const action of [()=>fs.readFileSync(${JSON.stringify(outside+'/secret')}),()=>fs.writeFileSync(${JSON.stringify(outside+'/changed')},'bad')]){try{action();process.exit(2)}catch{}}const s=net.connect(443,'1.1.1.1');s.on('connect',()=>process.exit(3));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(4),2000);`;
  await exec('/usr/bin/sandbox-exec',['-f',job+'/sandbox.sb',process.execPath,'-e',code],{timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:job,TMPDIR:job,ELECTRON_RUN_AS_NODE:'1'}});
  await assert.rejects(fs.stat(outside+'/changed'));
 }finally{await fs.rm(job,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
