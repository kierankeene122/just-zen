const fs=require('node:fs/promises');
const path=require('node:path');
const {prepareClaudeSandbox}=require('./claude-sandbox.cjs');

(async()=>{
 const cwd=path.join('/private/tmp','hearth-claude-sandbox-smoke');
 await fs.mkdir(cwd,{recursive:true});
 // The optional smoke reuses the developer's existing Claude login rather than the app-owned config directory.
 const sandbox=await prepareClaudeSandbox({fs,root:cwd,mode:'readOnly',userData:cwd,packageRoot:__dirname,configDir:path.join(require('node:os').homedir(),'.claude')});
 const env={...process.env,PATH:'/opt/homebrew/bin:/usr/local/bin:'+process.env.PATH};
 for(const key of ['ELECTRON_RUN_AS_NODE','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[key];
 const {query}=await import('@anthropic-ai/claude-agent-sdk');
 let passed=false;
 for await(const message of query({prompt:'Reply with exactly HEARTH_SANDBOX_OK and do not use tools.',options:{cwd,pathToClaudeCodeExecutable:sandbox.executable,env,permissionMode:'default',settingSources:['user'],maxTurns:1}})){
  if(message.type==='result' && String(message.result).includes('HEARTH_SANDBOX_OK'))passed=true;
 }
 if(!passed)throw Error('Sandboxed Claude did not return the expected response');
 console.log('CLAUDE SANDBOX PASS: subscription, network allowlist, authentication, read-only process boundary');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
