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
