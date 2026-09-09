const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {findClaude}=require('./claude-runtime.cjs');
test('the Claude CLI bundled with the Agent SDK is preferred over system installs',()=>{
 const found=findClaude({candidates:['/nonexistent/claude']});
 assert.ok(found.endsWith(path.join('claude-agent-sdk-darwin-arm64','claude')),found);
});
test('a system install is only a fallback, and a missing CLI is a clear error',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zen-claude-'));const fake=path.join(dir,'claude');fs.writeFileSync(fake,'#!/bin/sh\necho fake\n');fs.chmodSync(fake,0o755);
 try{
  assert.equal(findClaude({packageRoot:'/nonexistent',candidates:[fake]}),fake);
  assert.throws(()=>findClaude({packageRoot:'/nonexistent',candidates:['/nonexistent/claude']}),/Claude Code was not found/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
