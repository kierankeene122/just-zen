const {test}=require('node:test');
const assert=require('node:assert/strict');
const {decision,secureInside}=require('./claude-policy.cjs');
const root='/vault';
test('read-only mode allows known reads and blocks mutation and commands',()=>{
 assert.equal(decision('Read',{file_path:'/vault/note.md'},{mode:'readOnly',root}),null);
 assert.equal(decision('Write',{file_path:'/vault/note.md'},{mode:'readOnly',root}).decision,'deny');
 assert.equal(decision('Bash',{command:'touch note.md'},{mode:'readOnly',root}).decision,'deny');
});
test('workspace containment denies explicit paths outside the selected folder',()=>{
 assert.equal(decision('Read',{file_path:'/other/secret.md'},{mode:'full',root}).decision,'deny');
 assert.equal(decision('Edit',{file_path:'../secret.md'},{mode:'notes',root}).decision,'deny');
});
test('notes-only mode asks before non-Markdown changes and shell commands',()=>{
 assert.equal(decision('Write',{file_path:'/vault/note.md'},{mode:'notes',root}),null);
 assert.equal(decision('Edit',{file_path:'/vault/config.json'},{mode:'notes',root}).decision,'ask');
 assert.equal(decision('Bash',{command:'git status'},{mode:'notes',root}).decision,'ask');
});
test('resolved containment rejects a symlink that leaves the workspace',async t=>{const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const base=await fs.mkdtemp(path.join(os.tmpdir(),'hearth-policy-')),workspace=path.join(base,'workspace'),outside=path.join(base,'outside');await fs.mkdir(workspace);await fs.mkdir(outside);await fs.symlink(outside,path.join(workspace,'link'));t.after(()=>fs.rm(base,{recursive:true,force:true}));assert.equal(await secureInside(workspace,'link/secret.md'),false);assert.equal(await secureInside(workspace,'notes/new.md'),true);});
test('notes-only mode cannot write through a Markdown-named symlink to another file',async t=>{const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const {hook}=require('./claude-policy.cjs');const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'hearth-notes-'));t.after(()=>fs.rm(workspace,{recursive:true,force:true}));await fs.writeFile(path.join(workspace,'config.json'),'{}');await fs.symlink('config.json',path.join(workspace,'notes.md'));const run=hook(()=>({mode:'notes',root:workspace}));assert.equal((await run({tool_name:'Write',tool_input:{file_path:path.join(workspace,'notes.md'),content:'x'}})).hookSpecificOutput.permissionDecision,'deny');assert.deepEqual(await run({tool_name:'Write',tool_input:{file_path:path.join(workspace,'real.md'),content:'x'}}),{continue:true});assert.deepEqual(await run({tool_name:'Read',tool_input:{file_path:path.join(workspace,'notes.md')}}),{continue:true});});
test('MCP tools never inherit the trust of a built-in tool name',()=>{
 assert.equal(decision('mcp__server__Read',{},{mode:'readOnly',root}).decision,'deny');
 assert.equal(decision('mcp__server__Read',{},{mode:'notes',root}).decision,'ask');
 assert.equal(decision('mcp__server__anything',{},{mode:'full',root}).decision,'ask');
});
test('absolute or parent-relative Glob patterns count as paths',()=>{
 assert.equal(decision('Glob',{pattern:'/Volumes/**/*.pdf'},{mode:'readOnly',root}).decision,'deny');
 assert.equal(decision('Glob',{pattern:'../**/*.md'},{mode:'full',root}).decision,'deny');
 assert.equal(decision('Glob',{pattern:'**/*.md'},{mode:'readOnly',root}),null);
 assert.equal(decision('Grep',{pattern:'^/Users'},{mode:'readOnly',root}),null);
});
