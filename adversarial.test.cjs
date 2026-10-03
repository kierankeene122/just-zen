const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {secureInside,hook}=require('./claude-policy.cjs');
test('Claude rejects traversal, sibling-prefix paths and symlink chains including new targets',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zen-adversarial-')));try{
  const root=dir+'/workspace',outside=dir+'/workspace-private';await fs.mkdir(root);await fs.mkdir(outside);await fs.writeFile(outside+'/secret','private');await fs.symlink(outside,root+'/escape');await fs.symlink(root+'/escape',root+'/chain');
  for(const target of ['../workspace-private/secret',outside+'/secret','escape/secret','chain/new.md']){
   assert.equal(await secureInside(root,target),false,target);
   assert.equal((await hook(()=>({root,mode:'full'}))({tool_name:'Read',tool_input:{file_path:target}})).hookSpecificOutput.permissionDecision,'deny');
  }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});