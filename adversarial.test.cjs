const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {secureInside,hook}=require('./claude-policy.cjs');
const {createDocuments}=require('./documents.cjs');
test('Claude rejects traversal, sibling-prefix paths and symlink chains including new targets',async()=>{
 const dir=await fs.mkdtemp('/private/tmp/zen-adversarial-');try{
  const root=dir+'/workspace',outside=dir+'/workspace-private';await fs.mkdir(root);await fs.mkdir(outside);await fs.writeFile(outside+'/secret','private');await fs.symlink(outside,root+'/escape');await fs.symlink(root+'/escape',root+'/chain');
  for(const target of ['../workspace-private/secret',outside+'/secret','escape/secret','chain/new.md']){
   assert.equal(await secureInside(root,target),false,target);
   assert.equal((await hook(()=>({root,mode:'full'}))({tool_name:'Read',tool_input:{file_path:target}})).hookSpecificOutput.permissionDecision,'deny');
  }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Save copy cannot overwrite the original through a symlink or hardlink',async()=>{
 const dir=await fs.mkdtemp('/private/tmp/zen-save-attack-');try{
  const original=dir+'/original.txt';await fs.writeFile(original,'original');
  for(const kind of ['symlink','link']){
   const target=dir+'/'+kind+'.txt';await fs[kind](original,target);
   const docs=createDocuments({showOpenDialog:async()=>({filePaths:[original]}),showSaveDialog:async()=>({filePath:target})},()=>null);await docs.open();await assert.rejects(()=>docs.save({content:'overwritten'}),/ELOOP|separate regular file/);assert.equal(await fs.readFile(original,'utf8'),'original');
  }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
