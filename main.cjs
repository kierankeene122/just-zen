const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme, net, nativeImage, safeStorage, systemPreferences, session, Notification, webContents, clipboard, shell, desktopCapturer, globalShortcut, Tray, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const crypto=require('node:crypto');
const pty = require('node-pty');
const {ChatSession} = require('./chat.cjs');
const {catalogue,findApp,isAdded,addApp,bundledIcon} = require('./app-catalog.cjs');
const {createFaviconCache}=require('./favicons.cjs');
const {startAutoUpdates}=require('./auto-update.cjs');
const nativeApps=require('./native.cjs');
const {createSecureStore}=require('./secure-store.cjs');
const {prepareClaudeSandbox}=require('./claude-sandbox.cjs');
const {findNode}=require('./node-runtime.cjs');
const {findClaude}=require('./claude-runtime.cjs');
const {createImageDecoder}=require('./image-decoder.cjs');
const {describeUpdateState}=require('./update-state.cjs');
let favicon;
let chat;
// Every open web page is a WebContentsView keyed by app and tab; the renderer says which ones are on screen and where.
const BROWSER_KEY='browser';
const SLEEP_CHOICES=new Set([0,5,15,30,60,120]);
const { pathToFileURL } = require('node:url');
let flickWindow=null,pillWindow=null,tray=null,trayRefresh=()=>{},flickReady=false,pendingFlickMode='';
let updateReady='',checkUpdates=()=>{},installUpdate=()=>{};
function panelMode(){return config.startMode!=='window';}
function applyMenuBarOnly(){if(process.platform!=='darwin')return;try{if(config.menuBarOnly===true)app.dock?.hide();else app.dock?.show();}catch{}}
let win, terminal, root = null, claudeRoot = null, config = {}, secureStore, locked=false, lockTimer=null;
const entry = pathToFileURL(path.join(__dirname, 'index.html')).href;
// Test hooks are development-only: a packaged app ignores --smoke and HEARTH_DATA.
const smoke = process.argv.includes('--smoke') && !app.isPackaged;
// Storage stays stable when the executable is rebuilt or packaged by a different release tool.
// A source checkout (npm start) uses its own profile: its Electron binary carries a different code signature, so the
// Keychain key that encrypts the real profile's cookies is not available to it and Chromium would drop every login.
// HEARTH_DATA overrides the profile for smoke and visual tests.
app.setPath('userData',app.isPackaged?path.join(app.getPath('appData'),'Hearth'):(process.env.HEARTH_DATA || path.join(app.getPath('appData'),'Hearth-dev')));
// The smoke test mutates state (lock, notes, tasks), so it always runs in a fresh throwaway profile.
if(smoke)app.setPath('userData',require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(),'hearth-smoke-')));
// Claude Code login, settings and history used by Just Zen live here, separate from the user's own ~/.claude.
const claudeConfigDir=path.join(app.getPath('userData'),'claude-config');
let unlockFailures=0,unlockBlockedUntil=0;
app.on('certificate-error',(event,_contents,_url,_error,_certificate,callback)=>{event.preventDefault();callback(false);});
let writeQueue=Promise.resolve();
function persist(){writeQueue=writeQueue.catch(()=>{}).then(()=>secureStore.save(config));return writeQueue;}
let persistTimer=null;function persistSoon(){clearTimeout(persistTimer);persistTimer=setTimeout(()=>persist().catch(()=>{}),2000);persistTimer.unref?.();}
function trusted(event) { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== entry) throw Error('Untrusted request'); }
const LOCK_ALLOWED=new Set(['state','security-status','unlock-app']);
function handle(name, fn) { ipcMain.handle(name, async (e, ...args) => { trusted(e);if(locked && !LOCK_ALLOWED.has(name))throw Error('Just Zen is locked'); return fn(...args); }); }
// The flick bar is a window of ours too: these two channels trust it as well as the main window, and nothing else.
function handleShared(name,fn,getters){
  ipcMain.handle(name,async (e,...args)=>{
    const fromMain=win && !win.isDestroyed() && e.sender===win.webContents && e.senderFrame===win.webContents.mainFrame && e.senderFrame.url===entry;
    const fromOurs=getters.some(get=>{const w=get();return w && !w.isDestroyed() && e.sender===w.webContents && e.senderFrame===w.webContents.mainFrame;});
    if(!fromMain && !fromOurs)throw Error('Untrusted request');
    if(locked)throw Error('Just Zen is locked');
    return fn(...args);
  });
}
function send(name, value) { if (win && !win.isDestroyed()) win.webContents.send(name, value); }
function touchIDAvailable(){return process.platform==='darwin' && Boolean(systemPreferences.canPromptTouchID?.());}
function scheduleLock(){clearTimeout(lockTimer);if(!config.appLock || locked)return;lockTimer=setTimeout(()=>lockApp(),Math.max(1,Number(config.autoLockMinutes) || 15)*60_000);lockTimer.unref?.();}
async function authenticate(reason){if(!touchIDAvailable())throw Error('Touch ID is not available on this Mac');await systemPreferences.promptTouchID(reason);}
function passcodeHash(passcode,salt){return crypto.scryptSync(String(passcode),salt,32);}
function verifyPasscode(passcode){if(typeof passcode!=='string' || !config.lockSalt || !config.lockHash)return false;const actual=passcodeHash(passcode,Buffer.from(config.lockSalt,'base64')),expected=Buffer.from(config.lockHash,'base64');return actual.length===expected.length && crypto.timingSafeEqual(actual,expected);}
async function unlockAuthentication(passcode){
 if(Date.now()<unlockBlockedUntil)throw Error('Too many attempts. Try again in '+Math.ceil((unlockBlockedUntil-Date.now())/1000)+' seconds');
 if(config.appLockMethod==='passcode'){
  if(!verifyPasscode(passcode)){unlockFailures++;if(unlockFailures>=3)unlockBlockedUntil=Date.now()+Math.min(300,2**(unlockFailures-3))*1000;throw Error('Incorrect passcode');}
  unlockFailures=0;unlockBlockedUntil=0;return;
 }
 await authenticate('Unlock Just Zen');
}
// Anything hidden — another workspace, another pane, a background tab — is closed after a while and reloads when you go back.
const SLEEP_DEFAULT=30;
function stateSnapshot(){if(locked)return {locked:true,lockMethod:config.appLockMethod || 'touchID',theme:config.theme || 'light',version:app.getVersion()};return {locked:false,platform:process.platform,claudeSupported:CLAUDE_SUPPORTED,home:require('node:os').homedir(),root,claudeRoot,claudePolicy:config.claudePolicy || 'notes',claudeWorkspaces:config.claudeWorkspaces || (claudeRoot?[claudeRoot]:[]),connectedFolders:[...new Set([root,...(config.connectedFolders || []),...(config.claudeWorkspaces || [])].filter(Boolean))],services:config.services || [],appUses:config.appUses || {},todos:config.todos || [],taskFolders:taskFolders(),tourDone:Boolean(config.tourDone),version:app.getVersion(),theme:config.theme || 'light',mode:config.mode || 'chat',layout:config.layout || {},chat:chat.snapshot()};}
const MAX_PANES=8;
// Workspaces: each keeps its own split and its own apps in the panes. Apps themselves are shared; only the arrangement differs.
const MAX_WORKSPACES=9;
// Zoom is remembered per app and applied to every page of that app, whatever site it navigates to.
const ZOOM_STEPS=[0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2];
// Recent: unread counts that rose while the app's pane was not on screen, so nothing has to be toured.
// Chat apps stay alive in the background so their notifications keep arriving; they never sleep and every tab is loaded at startup.
const NOTIFICATION_WRAPPER=`(()=>{try{const N=window.Notification;if(!N || N.__zen)return;const notes=new Map();let seq=0;const W=function(title,options){const n=new N(title,options);const id=++seq;notes.set(id,n);setTimeout(()=>notes.delete(id),600000);try{window.postMessage({__zen:'notification',id,title:String(title),body:String(options&&options.body||'')},'*');}catch{}return n;};window.addEventListener('message',e=>{if(e.source!==window || !e.data || e.data.__zen!=='notification-click')return;const n=notes.get(e.data.id);if(!n)return;try{n.dispatchEvent(new Event('click'));}catch{}try{n.close();}catch{}});W.prototype=N.prototype;W.__zen=true;W.requestPermission=(...a)=>N.requestPermission(...a);Object.defineProperty(W,'permission',{get:()=>N.permission});Object.defineProperty(W,'maxActions',{get:()=>N.maxActions});window.Notification=W;}catch{}})()`;
// Chromium forgets session cookies (those without an expiry) when the app quits, so logins that rely on them are lost
// between launches. Like other app-hosting shells, Just Zen gives such cookies a rolling 30-day expiry inside their own profile.
const KEEP_LOGIN_DAYS=30;
const flushTimers=new WeakMap();
// The pill and the flick bar share a partition of their own, fenced to their own files.
let chromeSessionReady=false;
function chromeSession(){
  const target=session.fromPartition('zen-chrome');
  if(!chromeSessionReady){
    chromeSessionReady=true;
    const allowed=new Set(['flick.html','flick.js','pill.html','pill.js'].map(f=>pathToFileURL(path.join(__dirname,f)).href));
    target.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowed.has(details.url.split('#')[0])}));
    target.setPermissionRequestHandler((_c,_p,done)=>done(false));
    target.setPermissionCheckHandler(()=>false);
  }
  return target;
}
// ---- Flick: one field over the apps, documents, tabs and workspaces you already have ----
const iconCache=new Map();
async function appIcon(file){
  if(iconCache.has(file))return iconCache.get(file);
  let url='';
  try{
    const png=await nativeApps.appIconPng(file,path.join(app.getPath('userData'),'app-icons'));
    if(png){const image=nativeImage.createFromPath(png);if(!image.isEmpty())url=image.resize({width:36,height:36}).toDataURL();}
    if(!url){const image=await app.getFileIcon(file,{size:'normal'});url=image.isEmpty()?'':image.resize({width:36,height:36}).toDataURL();}
  }catch{}
  if(iconCache.size>400)iconCache.clear();
  iconCache.set(file,url);
  return url;
}
function score(label,needle){
  const name=String(label).toLowerCase();
  if(!needle)return 1;
  if(name===needle)return 6;
  if(name.startsWith(needle))return 5;
  if(name.split(/[\s._/-]+/).some(w=>w.startsWith(needle)))return 4;
  if(name.includes(needle))return 3;
  const initials=name.split(/[\s._/-]+/).filter(Boolean).map(w=>w[0]).join('');
  if(initials.startsWith(needle))return 3.5;
  let at=0;for(const ch of needle){at=name.indexOf(ch,at);if(at<0)return 0;at++;}
  return 1;
}
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}}
// Anything that looks like an address becomes a web app you can go to, or keep.
function webFromQuery(text){
  const raw=String(text || '').trim();
  if(!raw || /\s/.test(raw))return null;
  const candidate=/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)?raw:/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}([/?#].*)?$/i.test(raw)?'https://'+raw:'';
  if(!candidate)return null;
  try{
    const url=new URL(candidate);
    if(!['http:','https:'].includes(url.protocol))return null;
    return {kind:'web',id:'web:'+url.href,label:hostOf(url.href) || url.href,detail:url.href.slice(0,80),target:url.href,glyph:'◐'};
  }catch{return null;}
}
async function catalogueIcon(relative){
  if(!relative)return '';
  if(iconCache.has(relative))return iconCache.get(relative);
  let url='';
  try{url='data:image/png;base64,'+(await fs.readFile(path.join(__dirname,relative))).toString('base64');}catch{}
  iconCache.set(relative,url);
  return url;
}
// Going to a web app: if it is already open in a Safari tab, switch to that tab; otherwise open it as a new one.
async function openWebTarget(url){
  // Reuse a tab that already has the site open, in whichever browser this Mac calls the default one.
  if(config.safariTabs!==false && nativeApps.MAC){
    try{
      const want=new URL(url);
      const tabs=await nativeApps.browserTabs();
      const match=tabs.find(tab=>{try{const have=new URL(tab.url);return have.hostname.replace(/^www\./,'')===want.hostname.replace(/^www\./,'') && (want.pathname==='/' || have.pathname.startsWith(want.pathname.replace(/\/$/,'')));}catch{return false;}});
      if(match){await nativeApps.focusBrowserTab(match.target);return {ok:true};}
    }catch(error){config.safariTabs=false;persistSoon();await nativeApps.openInBrowser(url);return {ok:true,message:'Opened a new tab. '+error.message};}
  }
  await nativeApps.openInBrowser(url);
  return {ok:true};
}
// The page's own title makes a better label than its host name.
function pageTitle(url){
  return new Promise(resolve=>{
    let done=false;const finish=value=>{if(!done){done=true;resolve(value);}};
    setTimeout(()=>finish(''),4000);
    try{
      const request=net.request({url,redirect:'follow'});
      let body='';
      request.on('response',response=>{
        if(response.statusCode>=400)return finish('');
        response.on('data',chunk=>{body+=chunk.toString('utf8');if(body.length>8000){try{request.abort();}catch{}finish(titleFrom(body));}});
        response.on('end',()=>finish(titleFrom(body)));
        response.on('error',()=>finish(''));
      });
      request.on('error',()=>finish(''));
      request.end();
    }catch{finish('');}
  });
}
function titleFrom(html){
  const match=/<title[^>]*>([^<]{1,120})<\/title>/i.exec(html || '');
  if(!match)return '';
  return match[1].replace(/\s+/g,' ').trim().split(/\s[|\u2013\u2014-]\s/)[0].slice(0,40);
}
function savedWebApps(){
  return (config.services || []).filter(item=>item && item.url).map(item=>({kind:'web',id:'web:'+item.url,label:item.name,detail:hostOf(item.url),target:item.url,glyph:'◐',hint:'go to'}));
}
async function flickResults(query,stage,mode='open'){
  const needle=String(query || '').trim().toLowerCase();
  const out=[];
  if(stage==='fast'){
    const apps=await nativeApps.listApps();
    for(const item of apps){const s=score(item.label,needle);if(s)out.push({...item,group:'Apps',hint:'open',score:s});}
    for(const item of savedWebApps()){const s=score(item.label,needle);if(s)out.push({...item,group:'Your web apps',score:s});}
    const typed=webFromQuery(needle);
    if(typed)out.push({...typed,group:'Web apps',hint:mode==='pin'?'add':'go to',score:9});
    for(const entry of catalogue){const s=needle?score(entry.name,needle):(mode==='pin'?1:0);if(s)out.push({kind:'web',id:'web:'+entry.url,label:entry.name,detail:hostOf(entry.url),target:entry.url,glyph:'◐',group:'Web apps',hint:mode==='pin'?'add':'go to',score:s-0.2,iconFile:entry.icon});}
    for(const pin of (config.pins || [])){const s=score(pin.label,needle);if(s)out.push({...pin,group:'Pinned',score:s+1});}
    out.sort((a,b)=>b.score-a.score || a.label.localeCompare(b.label));
    const top=out.slice(0,needle?14:(mode==='pin'?26:10));
    for(const item of top){if(item.kind==='app')item.icon=await appIcon(item.target);else if(item.iconFile)item.icon=await catalogueIcon(item.iconFile);}
    return top.map(item=>({...item,detail:item.detail || '',hint:item.hint || ''}));
  }
  const slow=[];
  if(needle.length>=2){
    try{for(const doc of await nativeApps.findDocs(needle,{limit:8}))slow.push({...doc,group:'Documents',hint:'open',icon:await appIcon(doc.target)});}catch{}
    if(config.safariTabs!==false){
      try{for(const tab of await nativeApps.browserTabs()){const s=score(tab.label,needle);if(s)slow.push({...tab,group:'Open tabs',hint:'switch to',score:s});}}catch(error){slow.push({kind:'notice',id:'notice:tabs',label:'Open tabs are not available',detail:error.message,group:'Open tabs',glyph:'!'});}
    }
  }
  return slow.slice(0,14);
}
const flickIndex=new Map();
async function openFlick(id){
  const item=flickIndex.get(id);
  if(!item)return {ok:false,message:'That result went away. Try again.'};
  if(item.kind==='app'){
    const link=config.deepLinks===false?'':nativeApps.deepLinkFor(item.label);
    if(link){try{await shell.openExternal(link);return {ok:true};}catch{}}
    await nativeApps.openApp(item.target);return {ok:true};
  }
  if(item.kind==='file'){await nativeApps.openFile(item.target);return {ok:true};}
  if(item.kind==='tab'){await nativeApps.focusBrowserTab(item.target);return {ok:true};}
  if(item.kind==='url'){await shell.openExternal(item.target);return {ok:true};}
  if(item.kind==='web')return openWebTarget(item.target);

  return {ok:false,message:'Nothing to open there.'};
}
function showMainWindow(){if(!win || win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus();app.focus?.({steal:true});}
function flickTheme(){return config.theme==='dark'?'dark':'light';}
function ensureFlick(){
  if(flickWindow && !flickWindow.isDestroyed())return flickWindow;
  const {width,height}=screen.getPrimaryDisplay().workAreaSize;
  flickWindow=new BrowserWindow({
    width:720,height:460,x:Math.round((width-720)/2),y:Math.round(height*0.18),
    show:false,frame:false,transparent:true,hasShadow:true,resizable:false,movable:true,minimizable:false,maximizable:false,
    fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,type:process.platform==='darwin'?'panel':undefined,
    webPreferences:{preload:path.join(__dirname,'flick-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,session:chromeSession()}
  });
  flickWindow.setVisibleOnAllWorkspaces?.(true,{visibleOnFullScreen:true});
  const c=flickWindow.webContents;
  c.setWindowOpenHandler(()=>({action:'deny'}));c.on('will-navigate',e=>e.preventDefault());
  c.on('did-finish-load',()=>{flickReady=true;c.send('flick-theme',flickTheme());if(pendingFlickMode){c.send('flick-show',{mode:pendingFlickMode});pendingFlickMode='';}});
  flickWindow.on('blur',()=>{if(flickWindow && !flickWindow.isDestroyed())flickWindow.hide();});
  flickWindow.loadFile('flick.html');
  return flickWindow;
}
function toggleFlick(mode='open'){
  const w=ensureFlick();
  if(w.isVisible() && mode==='open'){w.hide();return;}
  w.webContents.send('flick-theme',flickTheme());
  w.showInactive();w.setAlwaysOnTop(true,'floating');w.focus();
  if(flickReady)w.webContents.send('flick-show',{mode:mode==='pin'?'pin':'open'});
  else pendingFlickMode=mode==='pin'?'pin':'open';
}
// Pins that pointed at an in-app pane become web pins now that web apps open in your browser.
function migratePins(){
  let changed=false;
  config.pins=(Array.isArray(config.pins)?config.pins:[]).map(pin=>{
    if(pin.kind!=='pane')return pin;
    changed=true;
    const item=(config.services || []).find(s=>(s.id || s.url)===String(pin.id || '').slice(5));
    if(item?.url)return {...pin,kind:'web',id:'web:'+item.url,target:item.url,detail:hostOf(item.url),glyph:'◐'};
    return null;
  }).filter(Boolean);
  if(changed)persistSoon();
}
function pinList(){
  return (Array.isArray(config.pins)?config.pins:[]).slice(0,40).map(pin=>({id:String(pin.id || '').slice(0,2000),kind:pin.kind,label:String(pin.label || '').slice(0,80),detail:String(pin.detail || '').slice(0,120),target:pin.target,icon:pin.icon || '',glyph:pin.glyph || '',folder:String(pin.folder || '').slice(0,40),iconFile:pin.iconFile || ''}));
}
async function sendPins(){
  send('pins-changed',pinList());
  if(!pillWindow || pillWindow.isDestroyed())return;
  const pins=pinList();
  for(const pin of pins){if(pin.icon)continue;if(pin.iconFile)pin.icon=await catalogueIcon(pin.iconFile);else if(pin.kind==='web' && typeof pin.target==='string'){try{pin.icon=await favicon(pin.target) || '';}catch{}}else if(typeof pin.target==='string' && (pin.kind==='app' || pin.kind==='file'))pin.icon=await appIcon(pin.target);}
  pillWindow.webContents.send('pill-pins',pins);
  const rows=new Set(pins.map(p=>p.folder).filter(Boolean)).size+pins.filter(p=>!p.folder).length;
  // An empty panel stands taller: it is the only thing on screen until something is added to it.
  const height=pins.length?Math.min(screen.getPrimaryDisplay().workAreaSize.height-80,130+rows*46):300;
  pillWindow.setBounds({...pillWindow.getBounds(),height:Math.round(height)});
}
function ensurePill(){
  if(pillWindow && !pillWindow.isDestroyed())return pillWindow;
  const display=screen.getPrimaryDisplay();
  const {x:ax,y:ay,width:aw,height:ah}=display.workArea;
  const width=70,height=(config.pins || []).length?Math.min(ah-80,130+(config.pins || []).length*46):300;
  const spot=config.pillSpot || {};
  pillWindow=new BrowserWindow({
    width,height:Math.round(height),
    x:Number.isFinite(spot.x)?Math.round(spot.x):ax+aw-width-8,
    y:Number.isFinite(spot.y)?Math.round(spot.y):Math.round(ay+(ah-height)/2),
    show:false,frame:false,transparent:true,hasShadow:false,resizable:false,movable:true,minimizable:false,maximizable:false,
    fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,acceptFirstMouse:true,type:process.platform==='darwin'?'panel':undefined,
    webPreferences:{preload:path.join(__dirname,'pill-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,session:chromeSession()}
  });
  pillWindow.setVisibleOnAllWorkspaces?.(true,{visibleOnFullScreen:true});
  const c=pillWindow.webContents;
  c.setWindowOpenHandler(()=>({action:'deny'}));c.on('will-navigate',e=>e.preventDefault());
  c.on('did-finish-load',()=>{c.send('pill-theme',flickTheme());sendPins();});
  pillWindow.on('moved',()=>{const b=pillWindow.getBounds();config.pillSpot={x:b.x,y:b.y};persistSoon();});
  pillWindow.loadFile('pill.html');
  return pillWindow;
}
function setPill(on){
  trayRefresh();
  config.pillOn=on===true;
  if(config.pillOn){const w=ensurePill();w.showInactive();}
  else if(pillWindow && !pillWindow.isDestroyed()){pillWindow.destroy();pillWindow=null;}
  persistSoon();
  send('pill-state',config.pillOn);
}
function askFolder(pinId){
  if(pillWindow && !pillWindow.isDestroyed()){pillWindow.webContents.send('pill-ask-group',{id:pinId});pillWindow.focus();}
}
async function openPin(id){
  const pin=pinList().find(p=>p.id===id);
  if(!pin)return;
  flickIndex.set(pin.id,pin);
  try{const result=await openFlick(pin.id);if(result && result.message)send('notice',result.message);}
  catch(error){send('notice',error.message);}
}
function announceServices(){send('services-changed',config.services || []);}
function addPin(item){
  config.pins=Array.isArray(config.pins)?config.pins:[];
  if(config.pins.some(p=>p.id===item.id))return false;
  if(config.pins.length>=40)throw Error('Forty things is the limit. Take one off first.');
  config.pins.push({id:item.id,kind:item.kind,label:item.label,detail:item.detail || '',target:item.target,icon:item.icon || '',glyph:item.glyph || '',iconFile:item.iconFile || '',folder:String(item.folder || '').slice(0,40)});
  persistSoon();sendPins();
  return true;
}
// The screen picker runs in the app's own window: thumbnails of every screen and window, and nothing shared until one is chosen.
const screenPicks=new Map();
async function localFile(relative) {
  if (!root || typeof relative !== 'string') throw Error('Choose a folder first');
  const real = await fs.realpath(path.resolve(root, relative));
  if (real !== root && !real.startsWith(root + path.sep)) throw Error('File is outside the selected folder');
  return real;
}
async function files(relative = '') {
  const dir = await localFile(relative);
  const entries = await fs.readdir(dir, {withFileTypes:true});
  return entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && !e.isSymbolicLink())
    .sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map(e => ({name:e.name, folder:e.isDirectory(), path:path.join(relative,e.name)}));
}
function validURL(value) {
  if(typeof value!=='string')throw Error('Enter a website address');
  const normalized=/^[a-z][a-z0-9+.-]*:/i.test(value.trim())?value.trim():'https://'+value.trim();
  const u=new URL(normalized);if(!['https:','http:'].includes(u.protocol) || !u.hostname || u.username || u.password)throw Error('Use an HTTP or HTTPS website address');return u.href;
}
async function securityStatus(){
 const result={version:app.getVersion(),electron:process.versions.electron,chromium:process.versions.chrome,packaged:app.isPackaged,signature:'Development runtime',gatekeeper:'Development runtime',updates:'Development checks disabled'};
 if(app.isPackaged){
  const bundle=path.resolve(path.dirname(process.execPath),'../..');let signing='';
  try{const value=await execFile('/usr/bin/codesign',['-dv','--verbose=4',bundle],{timeout:8000});signing=(value.stdout || '')+(value.stderr || '');}catch(error){signing=(error.stdout || '')+(error.stderr || '');}
  const team=signing.match(/TeamIdentifier=([^\n]+)/)?.[1];
  if(/Signature=adhoc|flags=.*adhoc/.test(signing))result.signature='Ad hoc only';else if(team && team!=='not set')result.signature='Developer ID · '+team;else result.signature='Unsigned or unverifiable';
  let gate='';try{const value=await execFile('/usr/sbin/spctl',['-a','-vv','--type','execute',bundle],{timeout:8000});gate=(value.stdout || '')+(value.stderr || '');}catch(error){gate=(error.stdout || '')+(error.stderr || '');}
  if(/source=Notarized Developer ID|origin=Developer ID/.test(gate) && /accepted/.test(gate))result.gatekeeper='Accepted and notarized';else if(result.signature==='Ad hoc only')result.gatekeeper='Not notarized';else result.gatekeeper='Not verified';
  try{const info=JSON.parse(await fs.readFile(path.join(process.resourcesPath,'build-info.json'),'utf8'));const s=info.electronSupport;if(s){const when=new Date(s.supportEnds).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});result.engineSupport=s.daysLeft<0?`Electron ${s.major} no longer receives Chromium security fixes (support ended ${when}). An update to a newer Electron is needed.`:`Chromium security fixes for Electron ${s.major} ${s.estimated?'until about':'until'} ${when} (Electron supports its three newest majors).`;}}catch{}
  try{await fs.access(path.join(process.resourcesPath,'app-update.yml'));result.updates='Signed release feed · checks on open and every 6 hours';}catch{result.updates=describeUpdateState(await fs.readFile(path.join(app.getPath('userData'),'update-state.json'),'utf8').then(JSON.parse).catch(()=>null));}
 }
 const profiles={shared:0,personal:0,work:0,isolated:0};for(const item of config.services || [])if(item.url)profiles[item.profile || 'isolated']++;
 return {...result,encrypted:Boolean(secureStore?.available()),profiles,claude:{connected:Boolean(claudeRoot),policy:config.claudePolicy || 'notes',sandboxed:true,terminalSandboxed:false},lock:{enabled:Boolean(config.appLock),locked,touchID:touchIDAvailable(),method:config.appLockMethod || (touchIDAvailable()?'touchID':'passcode'),minutes:Number(config.autoLockMinutes) || 15}};
}
// ---- Apps, tabs and on-screen placement ----
// Browsers are sidebar apps like any other, each with its own isolated profile, tabs, name and icon.
function isBrowserItem(item){return item?.kind==='browser';}
function openable(item){return Boolean(item && (item.url || isBrowserItem(item)));}
function serviceItem(serviceKey){return (config.services || []).find(s=>openable(s) && (s.id || s.url)===serviceKey) || null;}
function cleanEmoji(icon){const value=String(icon || '').trim();return [...value].slice(0,2).join('') || '🌐';}
// A popup (window.open, target=_blank, OAuth) becomes a new tab in the same pane; Chromium loads it and keeps the opener.
// Peek: a link opened from an app slides out in a drawer over the right of the centre instead of taking the whole pane.
// Esc dismisses it; it can be promoted to a tab, or opened beside. Popups and Shift+Space on a hovered link both land here.
const AUTH_HOSTS=/(^|\.)(accounts\.google\.com|accounts\.youtube\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|id\.atlassian\.com|login\.yahoo\.com|okta\.com|auth0\.com|login\.salesforce\.com|auth\.atlassian\.com|signin\.aws\.amazon\.com)$/i;

// Quiet chrome: a pane's buttons are placed all the time but only shown when they are wanted —
// while the pointer is near the top of that pane, while the pointer is on the buttons themselves,
// or while ⌘ is held. Until search has been used a few times they simply stay visible.
function retintChrome(){const theme=config.theme==='dark'?'dark':'light';for(const w of [flickWindow,pillWindow])if(w && !w.isDestroyed())w.webContents.send(w===flickWindow?'flick-theme':'pill-theme',theme);}
// An app can opt into the mobile web when its pane is thin (phone user agent and viewport); by default a narrow pane is just the site in a smaller window.
const MOBILE_WIDTH=480;
// A page that is a live call: Meet rooms, Teams meeting joins, Zoom meetings.
const MOBILE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Where something came from, so a task or a chat message can take you back: a tab (app + tab + address), a note, or the document pane.
function cleanFrom(from){if(!from || typeof from!=='object')return null;const s=(v,n)=>typeof v==='string'?v.slice(0,n):'';if(from.kind==='tab' && s(from.key,200))return {kind:'tab',key:s(from.key,200),tabId:s(from.tabId,100),url:/^https?:/i.test(s(from.url,2000))?s(from.url,2000):'',name:s(from.name,60)};if(from.kind==='note' && s(from.path,1000))return {kind:'note',path:s(from.path,1000)};if(from.kind==='document')return {kind:'document'};return null;}
function taskFolders(){config.taskFolders=(Array.isArray(config.taskFolders)?config.taskFolders:[]).filter(f=>f && typeof f.id==='string').map(f=>({id:f.id.slice(0,64),name:String(f.name || 'List').trim().slice(0,40) || 'List'}));return config.taskFolders;}
function validFolderId(id){return typeof id==='string' && taskFolders().some(f=>f.id===id)?id:null;}
function addTask(text,from=null,folderId=null){
  const clean=String(text || '').replace(/\s+/g,' ').trim().slice(0,300);if(!clean)throw Error('Enter a task');
  config.todos=config.todos || [];const todo={id:crypto.randomUUID(),text:clean,done:false,createdAt:Date.now()};const src=cleanFrom(from);if(src)todo.from=src;const folder=validFolderId(folderId);if(folder)todo.folderId=folder;config.todos.push(todo);persist();
  return config.todos;
}
function taskFromSelection(text,from=null){try{const todos=addTask(text,from);send('todos-changed',todos);send('notice','Added to your tasks: '+todos.at(-1).text.slice(0,80));}catch(error){send('notice',error.message);}}
async function iconFor(item){const local=bundledIcon(item);if(local)return 'data:image/png;base64,'+(await fs.readFile(path.join(__dirname,local))).toString('base64');try{return item?.url?await favicon(item.url):null;}catch{return null;}}
// Dark mode for websites: when the app is dark, pages that stay light are inverted (images and video inverted back). Nothing is touched in light mode.
const DARK_CSS='html{filter:invert(1) hue-rotate(180deg)!important;background:#111!important}img,video,canvas,picture,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}';
function retheme(){retintChrome();}
function subscriptionEnv(){
  const env={...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',PATH:'/opt/homebrew/bin:/usr/local/bin:'+process.env.PATH,CLAUDE_CONFIG_DIR:claudeConfigDir};
  delete env.ELECTRON_RUN_AS_NODE;
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[key];
  return env;
}
// Claude runs inside an operating-system sandbox, which this app only provides on macOS. Elsewhere it stays off rather than run unsandboxed.
const CLAUDE_SUPPORTED=process.platform==='darwin';
const CLAUDE_UNAVAILABLE='Claude is not available on Windows yet: it runs inside a macOS sandbox, and Just Zen will not run it without one.';
// findClaude throws when the bundled binary is missing (every non-macOS build). Nothing at startup may depend on it.
function claudeBinary(){try{return findClaude();}catch{return null;}}
function requireClaude(){if(!CLAUDE_SUPPORTED)throw Error(CLAUDE_UNAVAILABLE);return findClaude();}
function startTerminal(kind = 'claude') {
  if(!CLAUDE_SUPPORTED && kind!=='shell')throw Error(CLAUDE_UNAVAILABLE);
  if (kind!=='login' && !claudeRoot) throw Error('Choose a Claude workspace first');
  if(kind==='claude' && (config.claudePolicy || 'notes')!=='full')throw Error('Claude Terminal requires Full workspace mode. Use Chat for enforced Read-only or Notes-only access.');
  if (terminal) throw Error('A session is already running. Stop it before starting another.');
  if(chat?.state.busy)throw Error('Stop the chat turn before starting a terminal');
  const env=subscriptionEnv();
  // 'login' runs the CLI's browser sign-in against Just Zen's own Claude config directory.
  terminal = pty.spawn(kind === 'shell' ? (process.platform==='win32'?(process.env.COMSPEC || 'cmd.exe'):'/bin/zsh') : requireClaude(), kind === 'shell' ? ['-l'] : kind==='login' ? ['auth','login','--claudeai'] : [], {name:'xterm-256color',cols:70,rows:32,cwd:claudeRoot || app.getPath('userData'),env});
  const current = terminal;
  current.onData(data => send('terminal-data',data));
  current.onExit(({exitCode}) => { if(terminal === current) terminal = null; send('terminal-exit',exitCode); });
  return true;
}
// A failure during startup must never leave a running process with no window: say what went wrong and stop.
function startupFailed(error){
  const detail=String(error && error.stack || error);
  try{require('node:fs').appendFileSync(path.join(app.getPath('userData'),'startup-error.log'),new Date().toISOString()+' '+detail+'\n');}catch{}
  try{dialog.showErrorBox('Just Zen could not start',detail.slice(0,2000));}catch{}
  app.exit(1);
}
process.on('uncaughtException',error=>{if(!win)startupFailed(error);else console.error(error);});
app.whenReady().then(async () => {
  secureStore=createSecureStore({fs,safeStorage,userData:app.getPath('userData')});
  try { config = await secureStore.load(); if(config.root) root = await fs.realpath(config.root);if(config.claudeRoot)claudeRoot=await fs.realpath(config.claudeRoot);else if(root){claudeRoot=root;config.claudeRoot=root;}if(claudeRoot)config.claudeWorkspaces=[claudeRoot,...(config.claudeWorkspaces || []).filter(value=>value!==claudeRoot)].slice(0,12); } catch(error){console.error(error);config={};}
  if(!(config.services || []).some(isBrowserItem)){config.services=[{id:BROWSER_KEY,kind:'browser',name:'Browser',icon:'🌐',profile:'isolated'},...(config.services || [])];if(Array.isArray(config.sidebarOrder) && config.sidebarOrder.length)config.sidebarOrder=[BROWSER_KEY,...config.sidebarOrder.filter(e=>e!==BROWSER_KEY)];await persist();}
  const unprofiled=(config.services || []).some(item=>item.url && !item.profile);if(unprofiled){config.services=config.services.map(item=>item.url && !item.profile?{...item,profile:'isolated'}:item);await persist();}
  locked=Boolean(config.appLock);
  if(config.startMode===undefined)config.startMode='panel';
  migratePins();
  if(config.pillOn===undefined)config.pillOn=true;
  if(config.menuBarOnly===undefined)config.menuBarOnly=process.platform==='darwin';
  favicon=createFaviconCache(path.join(app.getPath('userData'),'favicons'),net,createImageDecoder({BrowserWindow}));
  nativeTheme.themeSource=config.theme || 'light';
  chat=new ChatSession({claudePath:claudeBinary(),emit:state=>send('chat-state',state),policy:()=>({mode:config.claudePolicy || 'notes',root:claudeRoot}),env:()=>({...subscriptionEnv(),ANTHROPIC_API_KEY:undefined,ANTHROPIC_AUTH_TOKEN:undefined,ANTHROPIC_BASE_URL:undefined,CLAUDE_CODE_USE_BEDROCK:undefined,CLAUDE_CODE_USE_VERTEX:undefined,CLAUDE_CODE_USE_FOUNDRY:undefined}),save:async state=>{if(!claudeRoot)return;config.chats=config.chats || {};config.chats[claudeRoot]=state;await persist();}});
  chat.restore(config.chats?.[claudeRoot]);
  win = new BrowserWindow({show:false,width:1440,height:940,minWidth:1100,minHeight:700,title:'Just Zen',icon:path.join(__dirname,'assets','justzen.png'),titleBarStyle:process.platform==='darwin'?'hiddenInset':'hidden',...(process.platform==='win32'?{titleBarOverlay:{color:'#ffffff',symbolColor:'#354258',height:44}}:{}),backgroundColor:'#ffffff',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  // Send the current selection, wherever the focus is, to the Claude context card or to Tasks. Nothing is sent to Claude until the user picks an action.
  async function sendSelectionTo(target){
    if(locked)return;
    const focused=webContents.getFocusedWebContents();
    if(!focused || focused===win.webContents){send('capture-selection',{target});return;}
    send('capture-selection',{target});
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Just Zen',submenu:[{role:'about'},{type:'separator'},{label:'Find anything…',accelerator:'Alt+Space',click:()=>{if(!locked)toggleFlick();}},{label:'Add to the panel…',accelerator:'Alt+Shift+A',click:()=>{if(!locked)toggleFlick('pin');}},{type:'separator'},{role:'quit'}]},
    {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'Window',submenu:[
      {label:'Just Zen Window',accelerator:'CmdOrCtrl+Alt+Space',click:()=>showMainWindow()},
      {label:'Send Selection to Claude',accelerator:'CmdOrCtrl+Shift+A',click:()=>sendSelectionTo('claude')},
      {label:'Send Selection to Tasks',accelerator:'CmdOrCtrl+Shift+T',click:()=>sendSelectionTo('task')},
      {type:'separator'},
      {label:'The Panel',type:'checkbox',checked:config.pillOn===true,click:item=>setPill(item.checked)},
      {role:'minimize'},{role:'close'}
    ]},
    {label:'View',submenu:[{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]}
  ]));  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.on('close',event=>{
    // In menu-bar mode the window is just another surface: closing it puts it away and leaves Just Zen running.
    if(!quitting && panelMode()){event.preventDefault();win.hide();return;}
    quitting=true;});
  win.on('closed',() => { try{terminal?.kill();}catch{} try{chat.stop();}catch{}
    // With the pill or the menu bar in play, closing the window puts Just Zen in the background rather than ending it.
    if(config.pillOn===true || config.menuBarOnly===true){if(flickWindow && !flickWindow.isDestroyed())flickWindow.hide();return;}
    quitting=true;app.quit();setTimeout(()=>app.exit(0),2500);
  });
  win.webContents.on('will-prevent-unload',e=>{if(quitting)e.preventDefault();});
  // ---- Flick bar and pill ----
  handle('flick-list',async ({query}={})=>{const items=await flickResults(query,'fast');const docs=await flickResults(query,'slow');const all=[...items,...docs].filter(i=>['app','file','url'].includes(i.kind));for(const item of all)flickIndex.set(item.id,item);return all.slice(0,12).map(({score,...rest})=>rest);});
  handleShared('flick-search',async ({query,stage,mode}={})=>{
    const items=await flickResults(query,stage,mode==='pin'?'pin':'open');
    for(const item of items)flickIndex.set(item.id,item);
    if(flickIndex.size>600)flickIndex.clear();
    return items.map(({score,...rest})=>rest);
  },[()=>flickWindow]);
  handleShared('flick-open',async ({id,pin}={})=>{
    if(pin===true){const item=flickIndex.get(String(id || ''));if(!item)throw Error('Nothing to pin');if(item.kind==='web' && !item.iconFile){const title=await pageTitle(item.target);if(title)item.label=title;}addPin(item);if(config.pillOn!==true)setPill(true);await persist();if(flickWindow && !flickWindow.isDestroyed())flickWindow.hide();return {ok:true,message:item.label+' is on the panel.'};}
    const result=await openFlick(String(id || ''));
    if(result?.ok && flickWindow && !flickWindow.isDestroyed())flickWindow.hide();
    return result;
  },[()=>flickWindow]);
  handle('pin-folder',async ({id,folder}={})=>{
    const pin=(config.pins || []).find(p=>p.id===id);
    if(!pin)throw Error('Not on the panel');
    pin.folder=String(folder || '').slice(0,40);
    await persist();sendPins();
    return pinList();
  });
  handle('pin-order',async ({order}={})=>{
    const byId=new Map((config.pins || []).map(p=>[p.id,p]));
    const next=[];
    for(const id of (Array.isArray(order)?order:[]).slice(0,40))if(byId.has(id)){next.push(byId.get(id));byId.delete(id);}
    for(const rest of byId.values())next.push(rest);
    config.pins=next;await persist();sendPins();
    return pinList();
  });
  handle('flick-pin',({id}={})=>{const item=flickIndex.get(String(id || ''));if(!item)throw Error('Nothing to pin');return addPin(item);});
  // A workspace can carry real apps and documents; switching to it opens them.
  handle('pill-pin',async ({kind,key}={})=>{
    if(kind==='pane'){const item=serviceItem(String(key || ''));if(!item)throw Error('App not found');addPin({id:'pane:'+(item.id || item.url),kind:'pane',label:item.name,detail:'Just Zen',glyph:'▣'});}
    else throw Error('Nothing to pin');
    if(config.pillOn!==true)setPill(true);
    await persist();
    return pinList();
  });
  handle('flick-toggle',({mode}={})=>{toggleFlick(mode==='pin'?'pin':'open');return true;});
  handle('pill-set',({on}={})=>{setPill(on===true);return config.pillOn===true;});
  handle('pill-state',()=>({on:config.pillOn===true,pins:pinList()}));
  handle('pill-unpin',async ({id}={})=>{config.pins=(config.pins || []).filter(p=>p.id!==id);await persist();sendPins();return pinList();});
  handle('safari-tabs-set',async ({on}={})=>{config.safariTabs=on===true;await persist();return config.safariTabs;});
  handle('native-settings',()=>({pillOn:config.pillOn===true,safariTabs:config.safariTabs!==false,deepLinks:config.deepLinks!==false,menuBarOnly:config.menuBarOnly===true,startWindow:config.startMode==='window'}));
  handle('native-set',async ({key,value}={})=>{
    if(!['pillOn','safariTabs','deepLinks','menuBarOnly','startWindow'].includes(key))throw Error('Unknown setting');
    if(key==='startWindow'){config.startMode=value===true?'window':'panel';trayRefresh();}else
    if(key==='pillOn')setPill(value===true);
    else config[key]=value===true;
    if(key==='menuBarOnly')applyMenuBarOnly();
    await persist();
    return {pillOn:config.pillOn===true,safariTabs:config.safariTabs!==false,deepLinks:config.deepLinks!==false,menuBarOnly:config.menuBarOnly===true,startWindow:config.startMode==='window'};
  });
  ipcMain.on('flick-close',e=>{if(flickWindow && !flickWindow.isDestroyed() && e.sender===flickWindow.webContents)flickWindow.hide();});
  const fromPill=e=>Boolean(pillWindow && !pillWindow.isDestroyed() && e.sender===pillWindow.webContents);
  ipcMain.on('pill-ready',e=>{if(fromPill(e))sendPins();});
  ipcMain.on('pill-open',(e,id)=>{if(fromPill(e))openPin(String(id || '')).catch(()=>{});});
  ipcMain.on('pill-flick',e=>{if(fromPill(e))toggleFlick();});
  ipcMain.on('pill-add',e=>{if(fromPill(e))toggleFlick('pin');});
  ipcMain.on('pill-group',(e,{id,folder}={})=>{
    if(!fromPill(e))return;
    const pin=(config.pins || []).find(p=>p.id===String(id || ''));
    if(!pin)return;
    pin.folder=String(folder || '').trim().slice(0,40);
    persistSoon();sendPins();
  });
  ipcMain.on('pill-home',e=>{if(fromPill(e))showMainWindow();});
  ipcMain.on('pill-menu',(e,id)=>{
    if(!fromPill(e))return;
    const pin=pinList().find(p=>p.id===String(id || ''));if(!pin)return;
    const folders=[...new Set(pinList().map(p=>p.folder).filter(Boolean))];
    Menu.buildFromTemplate([
      {label:'Open '+pin.label,click:()=>openPin(pin.id).catch(()=>{})},
      {type:'separator'},
      {label:'Group',submenu:[
        ...folders.map(name=>({label:name,type:'radio',checked:pin.folder===name,click:()=>{const p=(config.pins || []).find(x=>x.id===pin.id);if(p){p.folder=name;persistSoon();sendPins();}}})),
        ...(folders.length?[{type:'separator'}]:[]),
        {label:'New group…',click:()=>askFolder(pin.id)},
        ...(pin.folder?[{label:'Out of '+pin.folder,click:()=>{const p=(config.pins || []).find(x=>x.id===pin.id);if(p){p.folder='';persistSoon();sendPins();}}}]:[])
      ]},
      {label:'Add an app…',click:()=>toggleFlick('pin')},
      {type:'separator'},
      {label:'Take off the panel',click:()=>{config.pins=(config.pins || []).filter(p=>p.id!==pin.id);persistSoon();sendPins();}},
      {label:'Hide the panel',click:()=>setPill(false)}
    ]).popup({window:pillWindow});
  });
  ipcMain.on('pill-drop',async (e,{id,files}={})=>{
    if(!fromPill(e))return;
    const pin=pinList().find(p=>p.id===String(id || ''));
    const list=(Array.isArray(files)?files:[]).slice(0,5);
    if(!pin || !list.length)return;
    try{
      if(pin.kind==='app')for(const file of list)await nativeApps.openFile(file,{withApp:pin.target});
      else for(const file of list)await nativeApps.openFile(file);
    }catch(error){send('notice',error.message);}
  });
  handle('state',stateSnapshot);
  handle('security-status',securityStatus);
  handle('unlock-app',async passcode=>{if(!locked)return stateSnapshot();await unlockAuthentication(passcode);locked=false;scheduleLock();send('app-locked',{locked:false});return stateSnapshot();});
  handle('lock-app',()=>lockApp());
  handle('app-activity',()=>{scheduleLock();return true;});
  handle('set-app-lock',async ({enabled,minutes,passcode})=>{if(typeof enabled!=='boolean')throw Error('Invalid lock setting');if(enabled && !config.appLock){if(touchIDAvailable()){await authenticate('Enable the Just Zen app lock');config.appLockMethod='touchID';delete config.lockSalt;delete config.lockHash;}else{if(typeof passcode!=='string' || passcode.length<6 || passcode.length>128)throw Error('Choose a passcode between 6 and 128 characters');const salt=crypto.randomBytes(16);config.appLockMethod='passcode';config.lockSalt=salt.toString('base64');config.lockHash=passcodeHash(passcode,salt).toString('base64');}}if(!enabled){delete config.appLockMethod;delete config.lockSalt;delete config.lockHash;}config.appLock=enabled;config.autoLockMinutes=Math.max(1,Math.min(120,Number(minutes) || 15));await persist();if(enabled)scheduleLock();else clearTimeout(lockTimer);return securityStatus();});
  handle('choose-claude-folder',async () => {
    if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing its workspace');
    const result=await dialog.showOpenDialog(win,{title:'Choose the folder Claude may access',properties:['openDirectory']});
    if(result.canceled)return null;
    claudeRoot=await fs.realpath(result.filePaths[0]);config.claudeRoot=claudeRoot;config.claudeWorkspaces=[claudeRoot,...(config.claudeWorkspaces || []).filter(value=>value!==claudeRoot)].slice(0,12);chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return {root:claudeRoot,policy:config.claudePolicy || 'notes',workspaces:config.claudeWorkspaces};
  });
  handle('select-claude-folder',async value=>{if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing its workspace');if(typeof value!=='string' || !(config.claudeWorkspaces || []).includes(value))throw Error('Unknown Claude workspace');claudeRoot=await fs.realpath(value);config.claudeRoot=claudeRoot;chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return {root:claudeRoot,policy:config.claudePolicy || 'notes',workspaces:config.claudeWorkspaces};});
  handle('disconnect-claude-folder',async ()=>{if(terminal || chat.state.busy)throw Error('Stop the current Claude session before disconnecting its workspace');claudeRoot=null;delete config.claudeRoot;chat.restore(null);chat.publish();await persist();return true;});
  handle('set-claude-policy',async mode=>{if(!['full','notes','readOnly'].includes(mode))throw Error('Invalid Claude access mode');if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing access');config.claudePolicy=mode;await persist();return mode;});
  handle('appearance',async ({theme,mode,layout})=>{if(theme && !['light','dark'].includes(theme))throw Error('Invalid theme');if(mode && !['chat','terminal','files'].includes(mode))throw Error('Invalid mode');if(layout && typeof layout==='object')config.layout={agentCollapsed:Boolean(layout.agentCollapsed),page:['files-page','settings-page','brain-page'].includes(layout.page)?layout.page:'settings-page'};if(theme){config.theme=theme;nativeTheme.themeSource=theme;retheme();retintChrome();}if(mode)config.mode=mode;await persist();return true;});
  handle('chat-send',async (prompt,meta)=>{if(!CLAUDE_SUPPORTED)throw Error(CLAUDE_UNAVAILABLE);if(!claudeRoot)throw Error('Choose a Claude workspace first');if(terminal)throw Error('Stop the terminal session before sending a chat message');if(chat.state.busy)throw Error('Wait for the current reply');const sandbox=await prepareClaudeSandbox({fs,root:claudeRoot,mode:config.claudePolicy || 'notes',userData:app.getPath('userData'),packageRoot:__dirname,nodePath:findNode(),claudePath:findClaude(),configDir:claudeConfigDir});const openApps=(config.services || []).filter(openable).map(s=>s.name);chat.run(prompt,claudeRoot,sandbox.executable,{from:cleanFrom(meta?.from),apps:openApps}).catch(error=>send('notice',error.message));return true;});
  handle('chat-stop',()=>chat.stop());
  handle('claude-logout',async()=>{if(terminal || chat.state.busy)throw Error('Stop Claude before signing out');try{await execFile(requireClaude(),['auth','logout'],{env:subscriptionEnv(),timeout:15000});}catch(error){if(!/not logged in/i.test(String(error.stdout || '')+String(error.stderr || '')))throw Error('Sign-out failed: '+String(error.stderr || error.message).trim().slice(0,200));}chat.restore(null);chat.publish();config.chats={};await persist();return true;});
  handle('claude-auth-status',async()=>{let auth={loggedIn:false};try{auth=JSON.parse((await execFile(requireClaude(),['auth','status','--json'],{env:subscriptionEnv(),timeout:15000})).stdout);}catch(error){try{auth=JSON.parse(String(error.stdout || '{}'));}catch{}}return {loggedIn:Boolean(auth.loggedIn && auth.authMethod==='claude.ai'),installed:!(auth.loggedIn===false && !auth.authMethod && false)};});
  handle('chat-permission',value=>chat.respond(value));
  handle('chat-new',async ()=>{if(chat.state.busy)throw Error('Stop the current reply first');chat.restore(null);chat.publish();config.chats=config.chats || {};delete config.chats[claudeRoot];await persist();});
  // Tabs and placement: the renderer owns the layout; the main process owns the pages.
  handle('tour-done',async()=>{config.tourDone=true;await persist();return true;});
  // Deliver text into an app's composer (draft only; the user sends).
  const deliveries=new Map();
  // Opening a Recent entry takes you to the conversation: the page's own notification click handler runs, as if you had clicked the alert.
  if(!app.isPackaged)handle('debug-shell',()=>({winVisible:win.isVisible(),panelMode:panelMode(),pill:Boolean(pillWindow && !pillWindow.isDestroyed() && pillWindow.isVisible()),flick:Boolean(flickWindow && !flickWindow.isDestroyed()),dockHidden:process.platform==='darwin'?!app.dock?.isVisible?.():null,startMode:config.startMode,pins:(config.pins||[]).length}));
  // The visible text of an open tab, for "Ask Claude about this tab". Only tabs the user has open; capped, whitespace-collapsed.
  // Ask every loaded app to re-read its unread state right now (Home's Now strip refresh, or returning to Home).
  handle('clear-claude-history',async()=>{if(chat.state.busy)throw Error('Stop Claude before clearing history');config.chats={};chat.restore(null);chat.publish();await persist();return true;});
  // One ordering for the whole sidebar: 'group:<id>' entries and app keys, as the user arranged them.
  handle('add-todo',async input=>{const text=typeof input==='string'?input:input?.text;if(typeof text!=='string' || !text.trim())throw Error('Enter a task');addTask(text,typeof input==='object'?input.from:null,typeof input==='object'?input.folderId:null);await persist();return config.todos;});
  handle('create-task-folder',async ({name}={})=>{const clean=String(name || '').trim().slice(0,40);if(!clean)throw Error('Name the list');const folders=taskFolders();if(folders.length>=20)throw Error('Twenty lists is the limit');const folder={id:crypto.randomUUID(),name:clean};folders.push(folder);await persist();return {folders,id:folder.id};});
  handle('rename-task-folder',async ({id,name}={})=>{const folder=taskFolders().find(f=>f.id===id);if(!folder)throw Error('List not found');const clean=String(name || '').trim().slice(0,40);if(!clean)throw Error('Name the list');folder.name=clean;await persist();return taskFolders();});
  handle('remove-task-folder',async ({id}={})=>{const folders=taskFolders();const at=folders.findIndex(f=>f.id===id);if(at<0)throw Error('List not found');folders.splice(at,1);config.todos=(config.todos || []).map(t=>t.folderId===id?{...t,folderId:undefined}:t);await persist();return {folders:taskFolders(),todos:config.todos};});
  handle('move-task',async ({id,folderId}={})=>{let found=false;const target=validFolderId(folderId);config.todos=(config.todos || []).map(t=>{if(t.id!==id)return t;found=true;const next={...t};if(target)next.folderId=target;else delete next.folderId;return next;});if(!found)throw Error('Task not found');await persist();return config.todos;});
  handle('reorder-task-folders',async ({order}={})=>{if(!Array.isArray(order))throw Error('Invalid order');const folders=taskFolders();const byId=new Map(folders.map(f=>[f.id,f]));const next=[];for(const id of order.slice(0,20))if(byId.has(id)){next.push(byId.get(id));byId.delete(id);}for(const rest of byId.values())next.push(rest);config.taskFolders=next;await persist();return config.taskFolders;});
  handle('add-todos',async ({texts,from}={})=>{if(!Array.isArray(texts))throw Error('Nothing to add');let n=0;for(const t of texts.slice(0,50)){try{addTask(t,from);n++;}catch{}}await persist();return {todos:config.todos,added:n};});
  handle('delete-todo',async id=>{const index=(config.todos || []).findIndex(t=>t.id===id);if(index<0)throw Error('Task not found');const [todo]=config.todos.splice(index,1);await persist();return {todos:config.todos,snapshot:{todo,index}};});
  handle('restore-todo',async snapshot=>{const todo=snapshot?.todo;if(!todo || typeof todo.id!=='string' || typeof todo.text!=='string')throw Error('Nothing to restore');config.todos=config.todos || [];if(config.todos.some(t=>t.id===todo.id))return config.todos;config.todos.splice(Math.max(0,Math.min(config.todos.length,Number(snapshot.index) || 0)),0,{id:todo.id,text:todo.text.slice(0,300),done:Boolean(todo.done),createdAt:Number(todo.createdAt) || Date.now(),doneAt:todo.doneAt || null});await persist();return config.todos;});
  handle('toggle-todo',async id=>{let found=false;config.todos=(config.todos || []).map(todo=>{if(todo.id!==id)return todo;found=true;const done=!todo.done;return {...todo,done,doneAt:done?Date.now():null};});if(!found)throw Error('Task not found');await persist();return config.todos;});
  handle('favicon',async key=>{const item=(config.services || []).find(s=>(s.id || s.url)===key);const local=bundledIcon(item);if(local)return 'data:image/png;base64,'+(await fs.readFile(path.join(__dirname,local))).toString('base64');return item?.url?favicon(item.url):null;});
  handle('web-apps',()=>catalogue.map(item=>({...item,added:isAdded(config.services || [],item)})));
  handle('add-catalog-app',async id=>{config.services=addApp(config.services || [],id);await persist();announceServices();return config.services;});
  // Removals return a snapshot the renderer can hand back to 'restore-service' within the undo window; cookies are untouched.
  handle('remove-service',async key=>{const index=(config.services || []).findIndex(s=>(s.id || s.url)===key);if(index<0)throw Error('App not found');const item=config.services[index];closeServiceViews(key);config.services=config.services.filter((_,i)=>i!==index);const snapshot={item,index,tabs:(config.tabs || {})[key] || null,sleep:config.sleep?.apps?.[key],zoom:config.zoom?.[key],mute:config.mutes?.[key]};delete (config.tabs || {})[key];if(config.sleep?.apps)delete config.sleep.apps[key];if(config.zoom)delete config.zoom[key];if(config.mutes)delete config.mutes[key];await persist();announceServices();return {services:config.services,snapshot};});
  handle('add-browser',async ({name,icon}={})=>{if(typeof name!=='string' || !name.trim())throw Error('Name is required');config.services=config.services || [];const item={id:crypto.randomUUID(),kind:'browser',name:name.trim().slice(0,50),icon:cleanEmoji(icon),profile:'isolated'};config.services.push(item);await persist();announceServices();return {services:config.services,key:item.id};});
  handle('update-service',async ({key,name,icon,pinned,mobile}={})=>{let found=false;config.services=(config.services || []).map(item=>{if((item.id || item.url)!==key)return item;found=true;const next={...item};if(typeof name==='string' && name.trim())next.name=name.trim().slice(0,50);if(icon!==undefined && isBrowserItem(item))next.icon=cleanEmoji(icon);if(typeof pinned==='boolean')next.pinned=pinned;if(typeof mobile==='boolean')next.mobile=mobile;return next;});if(!found)throw Error('App not found');await persist();announceServices();return config.services;});
  handle('add-service',async ({name,url}) => { url = validURL(url); if(typeof name !== 'string' || !name.trim()) throw Error('Name is required'); config.services=config.services || [];if(!config.services.some(s=>s.url===url))config.services.push({id:require('node:crypto').randomUUID(),name:name.trim().slice(0,50),kind:'web',url,profile:'isolated'}); await persist(); announceServices();return config.services; });
  handle('start-terminal',kind => { if(!['claude','shell','login'].includes(kind)) throw Error('Invalid session'); return startTerminal(kind); });
  handle('stop-terminal',() => { terminal?.kill(); });
  handle('terminal-input',data => { if(typeof data === 'string' && data.length < 100000) terminal?.write(data); });
  handle('terminal-size',({cols,rows}) => { if(Number.isInteger(cols) && Number.isInteger(rows) && cols>0 && rows>0 && cols<1000 && rows<1000) terminal?.resize(cols,rows); });
  await win.loadFile('index.html');
  if(locked)await win.webContents.executeJavaScript("document.body.classList.add('is-locked');document.getElementById('lock-screen').classList.remove('hidden')");
  // The panel is the app: the window only appears when it is asked for, or when it is holding a lock screen.
  if(!panelMode() || locked)win.show();
  if(!locked)scheduleLock();
  const updates=startAutoUpdates(
    message=>{send('notice',message);if(!win.isVisible() && /No update|up to date|Checking/i.test(message)===false)notify('Just Zen',message);},
    version=>{updateReady=String(version || '');trayRefresh();send('update-ready',version);notify('Just Zen '+updateReady+' is ready','Choose Restart to update from the Just Zen menu.');}
  );
  checkUpdates=()=>{try{updates.checkNow?.();notify('Just Zen','Looking for a new version…');}catch(error){notify('Just Zen',error.message);}};
  installUpdate=()=>{try{updates.install?.();}catch(error){notify('Just Zen',error.message);}};
  function notify(title,body){try{if(Notification.isSupported())new Notification({title,body:String(body || '').slice(0,200)}).show();}catch{}}
  handle('install-update',()=>{if(!updates.install)throw Error('No update is ready');updates.install();return true;});
  handle('test-notification',()=>{if(!Notification.isSupported())throw Error('Notifications are not supported on this Mac');const n=new Notification({title:'Just Zen',body:'Notifications are working. If you did not see this, allow Just Zen in System Settings → Notifications.'});n.show();return true;});
  handle('check-updates',()=>{if(!updates.checkNow)throw Error(updates.reason==='development'?'Update checks are off in a development build.':'Updates are not available in this build.');updates.checkNow();return true;});
  // ---- Menu bar presence and the keys that reach Just Zen from anywhere ----
  try{
    const trayIcon=nativeImage.createFromPath(path.join(__dirname,'assets','justzen.png')).resize({width:18,height:18});
    trayIcon.setTemplateImage?.(process.platform==='darwin');
    tray=new Tray(trayIcon);
    tray.setToolTip('Just Zen');
    const buildTrayMenu=()=>Menu.buildFromTemplate([
      {label:'Find anything…',accelerator:'Alt+Space',click:()=>toggleFlick()},
      {label:'Add to the panel…',click:()=>toggleFlick('pin')},
      {label:'Claude, notes and tasks',click:()=>showMainWindow()},
      {type:'separator'},
      {label:'Show the panel',type:'checkbox',checked:config.pillOn===true,click:item=>setPill(item.checked)},
      {label:updateReady?('Restart to update to '+updateReady):'Check for updates…',click:()=>{if(updateReady)installUpdate();else checkUpdates();}},
      {label:'Settings',submenu:[
        {label:'Menu bar only (no Dock icon)',type:'checkbox',checked:config.menuBarOnly===true,click:item=>{config.menuBarOnly=item.checked;applyMenuBarOnly();persistSoon();}},
        {label:'Reuse an open browser tab',type:'checkbox',checked:config.safariTabs!==false,click:item=>{config.safariTabs=item.checked;persistSoon();trayRefresh();}},
        {label:'Land inside the app (Claude, Gemini, Slack)',type:'checkbox',checked:config.deepLinks!==false,click:item=>{config.deepLinks=item.checked;persistSoon();trayRefresh();}},
        {label:'Open the Claude window at launch',type:'checkbox',checked:config.startMode==='window',click:item=>{config.startMode=item.checked?'window':'panel';persistSoon();trayRefresh();}}
      ]},
      {type:'separator'},
      {label:'Quit Just Zen',click:()=>{quitting=true;app.quit();}}
    ]);
    tray.on('click',()=>{if(process.platform==='win32')toggleFlick();else tray.popUpContextMenu(buildTrayMenu());});
    tray.on('right-click',()=>tray.popUpContextMenu(buildTrayMenu()));
    tray.setContextMenu(buildTrayMenu());
    trayRefresh=()=>{try{tray.setContextMenu(buildTrayMenu());}catch{}};
  }catch{}
  applyMenuBarOnly();
  if(config.pillOn===true)setPill(true);
  for(const [accel,run] of [['Alt+Space',()=>toggleFlick()],['Alt+Shift+Space',()=>showMainWindow()]]){
    try{globalShortcut.register(accel,run);}catch{}
  }
  const sleeper=setInterval(()=>{sleepSweep();expireMutes();},30_000);sleeper.unref?.();
  // A hidden page is also told to throttle itself: Chromium slows timers and animations once the view is not visible.

  if(smoke) {
    try {
      for(const item of require('./app-catalog.cjs').catalogue){if(nativeImage.createFromPath(path.join(__dirname,item.icon)).isEmpty())throw Error('Invalid bundled icon: '+item.name);}
      root = path.join(__dirname,'smoke-vault');claudeRoot=root; await fs.mkdir(root,{recursive:true}); await fs.writeFile(path.join(root,'Welcome.md'),'# Test note');
      if(!(await files()).some(f=>f.name==='Welcome.md')) throw Error('File listing failed');
      let rejected = false; try { await localFile('../main.cjs'); } catch { rejected = true; } if(!rejected) throw Error('Path containment failed');
      const result = await win.webContents.executeJavaScript('document.title + ":" + Boolean(window.hearth)');
      if(result !== 'Just Zen:true') throw Error('Renderer bridge failed: '+result);
      if(!touchIDAvailable()){
        await win.webContents.executeJavaScript(`window.hearth.call('set-app-lock',{enabled:true,minutes:5,passcode:'HEARTH-SMOKE-PASSCODE'})`);
        await win.webContents.executeJavaScript(`window.hearth.call('lock-app')`);
        let wrong=false;try{await win.webContents.executeJavaScript(`window.hearth.call('unlock-app','wrong-passcode')`);}catch{wrong=true;}
        if(!wrong || !locked)throw Error('Passcode lock accepted an incorrect passcode');
        await win.webContents.executeJavaScript(`window.hearth.call('unlock-app','HEARTH-SMOKE-PASSCODE')`);
        if(locked)throw Error('Passcode unlock failed');
        await win.webContents.executeJavaScript(`window.hearth.call('set-app-lock',{enabled:false,passcode:'HEARTH-SMOKE-PASSCODE'})`);
      }
      // The finder reaches real things: an installed app, the web library, and an address typed by hand.
      const apps=await flickResults('safari','fast');
      if(!apps.some(item=>item.kind==='app'))throw Error('No applications found');
      const web=await flickResults('gmail','fast');
      if(!web.some(item=>item.kind==='web'))throw Error('Web app library missing');
      const typed=webFromQuery('example.com');
      if(!typed || typed.target!=='https://example.com/')throw Error('Typed address not understood');
      if(webFromQuery('not an address'))throw Error('Nonsense accepted as an address');
      // The panel keeps what it is given, and only what it is given.
      addPin({id:'web:https://example.com/',kind:'web',label:'Example',target:'https://example.com/'});
      if(pinList().length!==1)throw Error('Pin not kept');
      addPin({id:'web:https://example.com/',kind:'web',label:'Example',target:'https://example.com/'});
      if(pinList().length!==1)throw Error('Duplicate pin accepted');
      config.pins=[];
      const smokeTodos=addTask('  Smoke   task from a selection  ');if(smokeTodos.at(-1).text!=='Smoke task from a selection')throw Error('Task text not normalised');config.todos=[];
      await require('./smoke-adversarial.cjs')({});
      startTerminal('shell');
      await new Promise((resolve,reject) => {const timer=setTimeout(()=>reject(Error('PTY timed out')),5000); let output=''; terminal.onData(d=>{output+=d;if(output.includes('HEARTH_PTY_OK')){clearTimeout(timer);resolve();}}); terminal.write('echo HEARTH_PTY_OK\r');});
      terminal.kill();
      console.log('SMOKE PASS: renderer, bridge, lock, path containment, finder, panel, tasks, real PTY'); app.quit();
    } catch(e) {console.error(e);app.exit(1);}
  }
}).catch(startupFailed);
let quitting=false;
app.on('window-all-closed',()=>{if(config.pillOn===true || config.menuBarOnly===true)return;quitting=true;app.quit();setTimeout(()=>app.exit(0),2500);});
app.on('before-quit',()=>{quitting=true;try{globalShortcut.unregisterAll();}catch{}setTimeout(()=>app.exit(0),4000);});
// Dock click with no window left (a quit that stalled): start over rather than sit there.
app.on('activate',()=>{
  // Clicking the icon in panel mode should not conjure a window: the panel is already there.
  if(panelMode()){if(pillWindow && !pillWindow.isDestroyed())pillWindow.showInactive();return;}
  if(win && !win.isDestroyed()){win.show();win.focus();return;}
  if(config.pillOn===true || config.menuBarOnly===true){app.relaunch();app.exit(0);return;}
  if(!BrowserWindow.getAllWindows().length){app.relaunch();app.exit(0);}
});
