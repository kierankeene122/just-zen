const {randomUUID} = require('node:crypto');
const {hook:policyHook}=require('./claude-policy.cjs');

// The official SDK owns the Claude Code transport and authentication.
// Just Zen owns presentation and one-use permission responses.
class ChatSession {
  constructor({emit,save,query,env,policy=()=>({mode:'full',root:null}),claudePath='/opt/homebrew/bin/claude'}) { this.claudePath=claudePath;this.emit=emit;this.save=save;this.queryFactory=query;this.env=env;this.policy=policy;this.state={messages:[],sessionId:null,busy:false};this.pending=new Map(); }
  restore(value) {if(this.state.busy)throw Error('Stop chat before changing folders');this.state={messages:value?.messages || [],sessionId:value?.sessionId || null,busy:false};}
  snapshot(){return {...this.state,pending:[...this.pending.values()].map(p=>p.public)};}
  publish(){clearTimeout(this.publishTimer);this.publishTimer=null;this.emit(this.snapshot());}
  publishStream(){if(!this.publishTimer)this.publishTimer=setTimeout(()=>this.publish(),50);}
  add(role,text,extra={}){const message={id:randomUUID(),role,text,...extra};this.state.messages.push(message);this.publish();return message;}
  async permission(tool,input,options){
    const id=randomUUID();
    return new Promise(resolve=>{
      const finish=result=>{options.signal.removeEventListener('abort',abort);this.pending.delete(id);this.publish();resolve(result);};
      const abort=()=>finish({behavior:'deny',message:'Request cancelled',interrupt:true});
      const publicRequest={id,tool,input,title:options.title || `Allow ${tool}?`,description:options.description || options.decisionReason || ''};
      this.pending.set(id,{public:publicRequest,input,finish});
      if(options.signal.aborted){abort();return;}options.signal.addEventListener('abort',abort,{once:true});this.publish();
    });
  }
  respond({id,allow,answers}){
    const request=this.pending.get(id);if(!request)throw Error('This permission request is no longer active');
    if(typeof allow!=='boolean')throw Error('Invalid decision');
    let updatedInput=request.input;
    if(allow && request.public.tool==='AskUserQuestion'){
      if(!answers || typeof answers!=='object')throw Error('Please answer the questions first');
      const safe={};for(const q of request.input.questions || []){if(typeof answers[q.question]!=='string' || !answers[q.question].trim())throw Error('Please answer each question');safe[q.question]=answers[q.question].slice(0,10000);}
      updatedInput={...request.input,answers:safe};
    }
    request.finish(allow?{behavior:'allow',updatedInput}:{behavior:'deny',message:'The user declined this action.'});
  }
  stop(){this.aborter?.abort();this.active?.close();for(const request of [...this.pending.values()])request.finish({behavior:'deny',message:'Chat stopped',interrupt:true});}
  async run(prompt,cwd,executable='/opt/homebrew/bin/claude'){
    if(this.state.busy)throw Error('Wait for the current reply, or stop it first');
    if(typeof prompt!=='string' || !prompt.trim() || prompt.length>100000)throw Error('Enter a message up to 100,000 characters');
    this.state.busy=true;this.add('user',prompt.trim());this.aborter=new AbortController();
    const savedSession=this.state.sessionId;
    const task=this.consume(prompt.trim(),cwd,savedSession,executable);
    this.task=task;return task;
  }
  // The sandbox can read the Keychain but cannot write a refreshed token back, so an expired token is refreshed
  // by a minimal unsandboxed call (no workspace, no tools) and the turn is retried once.
  async refreshLogin(){
    const execFile=require('node:util').promisify(require('node:child_process').execFile);
    await execFile(this.claudePath,['-p','Reply with OK.','--max-turns','1'],{env:this.env(),cwd:require('node:os').tmpdir(),timeout:60000});
  }
  async consume(prompt,cwd,resume,executable,retried=false){
    let streamed=null,streamText='',assistantTextSeen=false,staleSession=false,expiredToken=false;
    const tools=new Map();
    try{
      if(!this.queryFactory){
        const execFile=require('node:util').promisify(require('node:child_process').execFile);
        // `claude auth status` exits non-zero when signed out, so read its JSON from either outcome.
        let auth={loggedIn:false};
        try{auth=JSON.parse((await execFile(this.claudePath,['auth','status','--json'],{env:this.env(),timeout:15000})).stdout);}
        catch(error){try{auth=JSON.parse(String(error.stdout || '{}'));}catch{if(error.code==='ENOENT')throw Error('Claude Code could not be started. Reinstall Just Zen and try again.');}}
        if(!auth.loggedIn || auth.authMethod!=='claude.ai')throw Error('Sign in to Claude first: click Sign in above the workspace picker. Just Zen keeps its own Claude login, separate from any other Claude Code setup on this Mac, so this is needed once.');
      }
      const query=this.queryFactory || (await import('@anthropic-ai/claude-agent-sdk')).query;
      const access=this.policy();
      const accessText=access.mode==='readOnly'?'Read-only: do not change files or run commands.':access.mode==='notes'?'Notes only: Markdown changes are expected; ask before changing anything else.':'Full workspace access, with explicit approval for commands that may reach outside it.';
      this.active=query({prompt,options:{cwd,pathToClaudeCodeExecutable:executable,env:this.env(),permissionMode:'default',settingSources:['user'],strictMcpConfig:true,systemPrompt:{type:'preset',preset:'claude_code',append:`Just Zen has selected exactly this workspace: ${JSON.stringify(cwd)}. ${accessText} Never claim access outside this folder.`},hooks:{PreToolUse:[{hooks:[policyHook(()=>this.policy())]}]},includePartialMessages:true,abortController:this.aborter,...(resume?{resume}:{}),canUseTool:(...args)=>this.permission(...args)}});
      for await(const message of this.active){
        if(message.session_id)this.state.sessionId=message.session_id;
        if(message.type==='stream_event' && !message.parent_tool_use_id){
          const event=message.event;
          if(event.type==='message_start'){streamed=null;streamText='';}
          if(event.type==='content_block_delta' && event.delta.type==='text_delta'){
            if(!streamed)streamed=this.add('assistant','');streamText+=event.delta.text;streamed.text=streamText;assistantTextSeen=true;this.publishStream();
          }
        }
        if(message.type==='assistant' && !message.parent_tool_use_id){
          const blocks=message.message.content || [];
          const text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
          if(text && !streamed){this.add('assistant',text);assistantTextSeen=true;}
          for(const block of blocks){if(block.type==='tool_use' && !tools.has(block.id)){const item=this.add('tool',JSON.stringify(block.input,null,2),{tool:block.name,toolId:block.id,status:'Running'});tools.set(block.id,item);}}
          if(message.error)this.add('error',`Claude Code: ${message.error}. Check your login or usage limits in Terminal mode.`);
        }
        if(message.type==='user'){
          for(const block of (Array.isArray(message.message?.content)?message.message.content:[])){
            if(block.type==='tool_result'){const item=tools.get(block.tool_use_id);if(item){item.status=block.is_error?'Failed':'Done';item.output=(typeof block.content==='string'?block.content:JSON.stringify(block.content)).slice(0,24000);this.publish();}}
          }
        }
        if(message.type==='result'){
          const errorText=message.is_error?(message.errors || [message.result || '']).join('\n'):'';
          if(message.is_error && resume && /No conversation found with session ID/i.test(errorText)){staleSession=true;}
          else if(message.is_error && /access token has expired|authentication_failed|401/i.test(errorText)){expiredToken=true;}
          else if(message.is_error)this.add('error',errorText || 'Claude could not finish this turn.');
          else if(!assistantTextSeen && message.result)this.add('assistant',message.result);
        }
      }
    }catch(error){this.add(this.aborter.signal.aborted?'system':'error',this.aborter.signal.aborted?'Stopped. You can continue this conversation.':error.message);}
    finally{
      this.active?.close();this.active=null;
      for(const request of [...this.pending.values()])request.finish({behavior:'deny',message:'Turn ended'});
      if(expiredToken && !retried){let refreshed=false;try{await this.refreshLogin();refreshed=true;}catch{}
        if(refreshed){this.state.busy=true;this.aborter=new AbortController();return this.consume(prompt,cwd,resume,executable,true);}
        this.add('error','Your Claude login has expired and could not be refreshed. Click Sign in to sign in again.');}
      else if(expiredToken)this.add('error','Your Claude login has expired. Click Sign in to sign in again.');
      if(staleSession && !retried){this.state.sessionId=null;this.state.busy=true;this.aborter=new AbortController();return this.consume(prompt,cwd,null,executable,true);}
      if(staleSession)this.add('error','The saved conversation could not be resumed. Start a new chat.');
      this.state.busy=false;
      try{await this.save({sessionId:this.state.sessionId,messages:this.state.messages.slice(-200)});}catch{this.add('error','Could not save chat history on this Mac.');}
      this.publish();
    }
  }
}
module.exports={ChatSession};
