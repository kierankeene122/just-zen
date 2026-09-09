const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');

test('Anthropic Sandbox Runtime blocks a read outside the granted workspace',{skip:process.platform!=='darwin' || !process.env.RUN_SRT},async()=>{
 const run=promisify(execFile),base=await fs.mkdtemp(path.join(os.tmpdir(),'hearth-srt-')),workspace=path.join(base,'workspace'),secret=path.join(base,'secret.txt'),config=path.join(base,'settings.json');
 await fs.mkdir(workspace);await fs.writeFile(secret,'must stay private');
 await fs.writeFile(config,JSON.stringify({network:{allowedDomains:[],deniedDomains:[],allowUnixSockets:[],allowLocalBinding:false},filesystem:{denyRead:[base],allowRead:[workspace,config],allowWrite:[],denyWrite:[]},enableWeakerNestedSandbox:false,enableWeakerNetworkIsolation:false,allowAppleEvents:false}));
 const cli=path.join(__dirname,'node_modules','@anthropic-ai','sandbox-runtime','dist','cli.js');
 await assert.rejects(run(process.execPath,[cli,'--settings',config,'--','/bin/cat',secret],{timeout:20000}),error=>/Operation not permitted|denied|blocked/i.test(String(error.stderr || error.message)));
});

test('the Just Zen sandbox settings deny personal Claude state, volumes and temporary folders',{skip:process.platform!=='darwin' || !process.env.RUN_SRT},async t=>{
 const run=promisify(execFile),{settings}=require('./claude-sandbox.cjs');
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'hearth-srt-app-')),workspace=path.join(base,'workspace'),userData=path.join(base,'data'),config=path.join(base,'settings.json');
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 await fs.mkdir(workspace);await fs.mkdir(path.join(userData,'claude-config','projects','other'),{recursive:true});await fs.writeFile(path.join(userData,'claude-config','projects','other','transcript.jsonl'),'x');
 const rules=settings({root:workspace,mode:'readOnly',userData,otherProjects:['other']});rules.filesystem.allowRead.push(config);
 const own=path.join(userData,'claude-config','projects',workspace.replace(/[^a-zA-Z0-9_-]/g,'-'));await fs.mkdir(own,{recursive:true});await fs.writeFile(path.join(own,'session.jsonl'),'x');
 await fs.writeFile(config,JSON.stringify(rules));
 const cli=path.join(__dirname,'node_modules','@anthropic-ai','sandbox-runtime','dist','cli.js');
 const inside=(command,...args)=>run(process.execPath,[cli,'--settings',config,'--',command,...args],{timeout:20000});
 await inside('/bin/ls',workspace);
 await inside('/bin/cat',path.join(own,'session.jsonl'));
 for(const denied of [os.homedir(),'/Volumes','/Users/Shared','/private/tmp',path.join(os.homedir(),'.claude'),path.join(userData,'claude-config','projects','other')])await assert.rejects(inside('/bin/ls',denied),undefined,denied+' must be denied');
 await assert.rejects(inside('/bin/cat',path.join(os.homedir(),'.claude.json')));
});
