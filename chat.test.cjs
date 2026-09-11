const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ChatSession}=require('./chat.cjs');
const fake=(fn)=>args=>{const iterator=fn(args);iterator.close=()=>{};return iterator;};
test('a burst of streamed tokens is batched without losing final text',async()=>{
 let updates=0,last;
 const chat=new ChatSession({env:()=>({}),emit:s=>{updates++;last=structuredClone(s);},save:async()=>{},query:fake(async function*(){
  for(let i=0;i<1000;i++)yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'x'}}};
 })});
 await chat.run('Stream','/tmp');
 assert.equal(last.messages.find(m=>m.role==='assistant').text,'x'.repeat(1000));
 assert.equal(last.busy,false);assert(updates<10,`Unexpected ${updates} full conversation updates`);
});
test('streamed reply is not duplicated; session can resume',async()=>{
 let saved,options;
 const chat=new ChatSession({env:()=>({}),emit:()=>{},save:async s=>{saved=s;},query:fake(async function*({options:o}){options=o;yield {type:'stream_event',session_id:'session-test',event:{type:'message_start'}};yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Hello'}}};yield {type:'assistant',message:{content:[{type:'text',text:'Hello'}]}};yield {type:'result',result:'Hello',is_error:false};})});
 await chat.run('Hi','/tmp');assert.equal(chat.state.busy,false);assert.equal(saved.sessionId,'session-test');assert.equal(saved.messages.filter(m=>m.role==='assistant').length,1);await chat.run('Again','/tmp');assert.equal(options.resume,'session-test');assert.equal(options.permissionMode,'default');
});
test('tool waits for explicit approval and uses original input',async()=>{
 let chat;let result;
 chat=new ChatSession({env:()=>({}),save:async()=>{},emit:state=>{if(state.pending.length){const p=state.pending[0];queueMicrotask(()=>chat.respond({id:p.id,allow:true}));}},query:fake(async function*({options}){result=await options.canUseTool('Write',{file_path:'/tmp/test',content:'test'},{signal:new AbortController().signal});yield {type:'result',result:'Done'};})});
 await chat.run('Write','/tmp');assert.equal(result.behavior,'allow');assert.equal(result.updatedInput.file_path,'/tmp/test');assert.equal(chat.pending.size,0);
});
test('denial and cancellation fail closed',async()=>{
 const chat=new ChatSession({env:()=>({}),save:async()=>{},emit:()=>{}});const controller=new AbortController();const denied=chat.permission('Bash',{command:'test'},{signal:controller.signal});const id=[...chat.pending.keys()][0];chat.respond({id,allow:false});assert.equal((await denied).behavior,'deny');const cancelled=chat.permission('Bash',{command:'test'},{signal:controller.signal});controller.abort();assert.equal((await cancelled).behavior,'deny');assert.equal(chat.pending.size,0);assert.throws(()=>chat.respond({id,allow:true}));
});
test('a stale saved session thrown by the SDK is retried once without resume and with a recap',async()=>{
 const seen=[];
 const chat=new ChatSession({env:()=>({}),emit:()=>{},save:async()=>{},query:fake(async function*({prompt,options}){seen.push({prompt,resume:options.resume});if(options.resume)throw Error('Claude Code returned an error result: No conversation found with session ID: 2facbfac-5aa5-41e6-91ee-ea9158f4fc13');yield {type:'result',result:'Fresh reply',is_error:false};})});
 chat.restore({sessionId:'old-session',messages:[{id:'1',role:'user',text:'What is the plan?'},{id:'2',role:'assistant',text:'Three steps.'}]});
 await chat.run('Go on','/tmp');
 assert.equal(seen.length,2);assert.equal(seen[0].resume,'old-session');assert.equal(seen[1].resume,undefined);
 assert.match(seen[1].prompt,/recap/);assert.match(seen[1].prompt,/Three steps/);assert.match(seen[1].prompt,/Go on$/);
 assert.equal(chat.state.sessionId,null);assert.ok(!chat.state.messages.some(m=>m.role==='error'),'no error is shown when the retry succeeds');
 assert.equal(chat.state.messages.at(-1).text,'Fresh reply');assert.equal(chat.state.busy,false);
});
test('a user message keeps the source it came from',async()=>{
 let saved;const chat=new ChatSession({env:()=>({}),emit:()=>{},save:async s=>{saved=s;},query:fake(async function*(){yield {type:'result',result:'ok',is_error:false};})});
 await chat.run('Summarise this','/tmp','/usr/bin/true',{from:{kind:'tab',key:'web-gmail',tabId:'main',url:'https://mail.google.com/',name:'Gmail'}});
 assert.equal(saved.messages[0].from.name,'Gmail');assert.equal(saved.messages[0].from.kind,'tab');
});
