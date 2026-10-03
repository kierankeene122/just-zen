const assert=require('node:assert/strict'),path=require('node:path');
const {BrowserWindow}=require('electron');
// Just Zen's surface is small now: a window of its own, a panel and a finder. The only thing a hostile page
// could reach for is the IPC bridge, so that is what this proves: a renderer that is not ours is refused everything.
module.exports=async function(){
 const windows=[];
 try{
  const attacker=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'smoke-adversary-preload.cjs')}});
  windows.push(attacker);
  await attacker.loadURL('about:blank');
  const denied=await attacker.webContents.executeJavaScript(`(async()=>{
    const results=[];
    for(const [channel,args] of [['start-terminal',['shell']],['read',['/etc/passwd']],['state',[]],['flick-search',[{query:'a'}]],['flick-open',[{id:'app:/Applications/Calculator.app'}]],['native-set',[{key:'pillOn',value:true}]],['add-todo',[{text:'from an attacker'}]]]){
      try{await window.probe.invoke(channel,...args);results.push(false);}catch{results.push(true);}
    }
    return results;
  })()`);
  assert.ok(denied.every(Boolean),'Foreign renderer IPC must be rejected');
  console.log('ADVERSARIAL PASS: foreign IPC denied on every channel');
 }finally{for(const w of windows)if(!w.isDestroyed())w.destroy();}
};
