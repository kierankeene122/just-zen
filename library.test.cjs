const test = require('node:test');
const assert = require('node:assert/strict');
const {catalogue,addApp,isAdded,bundledIcon} = require('./app-catalog.cjs');
const {sharedWebPreferences,configureWebContents} = require('./web-session.cjs');
test('library has 101 distinct web services across business and personal categories',()=>{
 assert.equal(catalogue.length,101);
 assert.equal(new Set(catalogue.map(a=>a.id)).size,101);
 assert.equal(new Set(catalogue.map(a=>a.url.toLowerCase().replace(/\/$/,''))).size,101);
 assert.ok(new Set(catalogue.map(a=>a.category)).size>=5);
 for(const a of catalogue){assert.ok(a.name);assert.ok(require('node:fs').readFileSync(require('node:path').join(__dirname,a.icon)).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));assert.match(a.url,/^https?:\/\//);assert.ok(new URL(a.url).hostname);}
 for(const name of ['Gmail','Slack','YouTube','YouTube Music','ChatGPT','Google Drive','WhatsApp'])assert.ok(catalogue.some(a=>a.name===name),name);
});
test('one-click adds preserve existing apps and reject duplicates or unknown ids',()=>{
 const app=catalogue.find(a=>a.name==='Gmail');const existing=[{id:'vault',kind:'vault'}];
 const result=addApp(existing,app.id);assert.equal(result.length,2);assert.equal(existing.length,1);
 assert.equal(addApp(result,app.id),result);
 assert.ok(isAdded([{url:app.url.replace(/\/$/,'')}],app));
 assert.throws(()=>addApp(result,'untrusted-id'));
});
test('bundled icons distinguish products and custom sites keep favicon fallback',()=>{
 const forms=catalogue.find(a=>a.name==='Google Forms');
 assert.equal(bundledIcon({url:'https://docs.google.com/forms/d/test'}),forms.icon);
 assert.equal(bundledIcon({url:'https://mail.google.com/mail/u/1/'}),catalogue.find(a=>a.name==='Gmail').icon);
 assert.equal(bundledIcon({url:'https://example.com/'}),null);
 assert.equal(bundledIcon({url:'https://mail.google.com.attacker.example/'}),null);
});
test('tabs and OAuth popups use one persistent sandboxed session',()=>{
 const handlers={};let open;
 configureWebContents({on:(name,fn)=>handlers[name]=fn,setWindowOpenHandler:fn=>open=fn},'parent');
 const prefs=sharedWebPreferences();assert.equal(prefs.partition,'persist:services');assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.sandbox,true);
 const popup=open({url:'https://accounts.google.com/'});assert.equal(popup.action,'allow');assert.deepEqual(popup.overrideBrowserWindowOptions.webPreferences,prefs);
 assert.equal(open({url:'file:///etc/passwd'}).action,'deny');
 let prevented=false;handlers['will-navigate']({preventDefault:()=>prevented=true},'javascript:alert(1)');assert.ok(prevented);
});
