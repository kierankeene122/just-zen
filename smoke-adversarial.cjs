const assert=require('node:assert/strict'),path=require('node:path'),http=require('node:http');
const {BrowserWindow,session}=require('electron');
const {webPreferences,configureWebContents}=require('./web-session.cjs');
module.exports=async function({documentContents}){
 const windows=[];const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local adversarial fixture</title>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const attacker=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'smoke-adversary-preload.cjs'),partition:'adversary-ipc'}});windows.push(attacker);await attacker.loadURL(url);
  const denied=await attacker.webContents.executeJavaScript(`(async()=>{const results=[];for(const [channel,args] of [['start-terminal',['shell']],['read',['/etc/passwd']],['state',[]],['document-open',[]],['document-save',[{content:'attack'}]],['select-claude-folder',['/']]]){try{await window.probe.invoke(channel,...args);results.push(false);}catch(e){results.push(/Untrusted/.test(e.message));}}return results;})()`);
  assert.ok(denied.every(Boolean),'Foreign renderer IPC must be rejected');
  const first=new BrowserWindow({show:false,webPreferences:webPreferences('isolated','attack-a')}),second=new BrowserWindow({show:false,webPreferences:webPreferences('isolated','attack-b')});windows.push(first,second);
  await Promise.all([first.loadURL(url),second.loadURL(url)]);
  await first.webContents.executeJavaScript(`document.cookie='secret=profile-a';localStorage.setItem('secret','profile-a')`);
  assert.equal(await second.webContents.executeJavaScript(`document.cookie.includes('profile-a') || localStorage.getItem('secret')!==null`),false);
  configureWebContents(first.webContents,first,()=>{},first.webContents,webPreferences('isolated','attack-a'));
  const children=[];first.webContents.on('did-create-window',(child,details)=>{children.push({child,url:details.url});windows.push(child);});
  for(const target of ['file:///etc/passwd','javascript:window.__unexpected=1','data:text/html,attack','msteams://evil.example/'])await first.webContents.executeJavaScript(`window.open(${JSON.stringify(target)});void 0`,true);
  await new Promise(r=>setTimeout(r,200));for(const {child,url:target} of children){assert.equal(target,'about:blank','Only a normalised blank popup may be created');assert.equal(child.webContents.session,first.webContents.session);const prefs=child.webContents.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);}
  const created=new Promise((r,reject)=>{const timeout=setTimeout(()=>reject(Error('OAuth popup timed out')),5000);first.webContents.once('did-create-window',w=>{clearTimeout(timeout);r(w);});});await first.webContents.executeJavaScript(`window.open(${JSON.stringify(url+'/oauth')});void 0`,true);const popup=await created;windows.push(popup);assert.equal(popup.webContents.session,first.webContents.session,'OAuth popup must inherit profile');assert.notEqual(popup.webContents.session,second.webContents.session);
  const result=await documentContents.executeJavaScript(`(async()=>{const original=window.__attack;const html='<img src="https://example.com/leak" onerror="window.__attack=1"><script>window.__attack=1<'+ '/script><iframe src="file:///etc/passwd"></iframe><p>Safe text</p>';const host=document.createElement('div');host.innerHTML=DOMPurify.sanitize(html,{ALLOWED_TAGS:['p','b','i'],ALLOWED_ATTR:[]});document.body.append(host);await new Promise(r=>setTimeout(r,50));const safe=!host.querySelector('img,script,iframe') && window.__attack===original;host.remove();return safe;})()`);assert.equal(result,true);
  console.log('ADVERSARIAL PASS: foreign IPC denied, profiles separated, popups contained, hostile HTML sanitised');
 }finally{for(const w of windows)if(!w.isDestroyed())w.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
};
