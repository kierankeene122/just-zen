const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme, net, nativeImage, safeStorage, systemPreferences, session, Notification, webContents, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const crypto=require('node:crypto');
const pty = require('node-pty');
const {ChatSession} = require('./chat.cjs');
const {catalogue,findApp,isAdded,addApp,bundledIcon} = require('./app-catalog.cjs');
const {webPreferences,browserWebPreferences,browserPartition,BROWSER_PARTITION,configureWebContents,PROFILES,partitionFor} = require('./web-session.cjs');
const {reorder,createFolder,updateFolder,removeFolder,setFolder}=require('./sidebar.cjs');
const {createFaviconCache}=require('./favicons.cjs');
const {startAutoUpdates}=require('./auto-update.cjs');
const {createSecureStore}=require('./secure-store.cjs');
const {prepareClaudeSandbox}=require('./claude-sandbox.cjs');
const {canNotify,unreadCount,secureOrigin}=require('./notifications.cjs');
const {findNode}=require('./node-runtime.cjs');
const {findClaude}=require('./claude-runtime.cjs');
const {createImageDecoder}=require('./image-decoder.cjs');
const {describeUpdateState}=require('./update-state.cjs');
let favicon;
let chat;
// Every open web page is a WebContentsView keyed by app and tab; the renderer says which ones are on screen and where.
const views=new Map();
const BROWSER_KEY='browser';
const SLEEP_CHOICES=new Set([0,5,15,30,60,120]);
const notificationSources=new WeakMap(),notificationOrigins=new WeakMap(),serviceBadges=new Map();
const { pathToFileURL } = require('node:url');
let win, terminal, root = null, claudeRoot = null, config = {}, secureStore, locked=false, lockTimer=null;
const entry = pathToFileURL(path.join(__dirname, 'index.html')).href;
// Test hooks are development-only: a packaged app ignores --smoke and HEARTH_DATA.
const smoke = process.argv.includes('--smoke') && !app.isPackaged;
// Storage stays stable when the executable is rebuilt or packaged by a different release tool.
// A source checkout (npm start) uses its own profile: its Electron binary carries a different code signature, so the
// Keychain key that encrypts the real profile's cookies is not available to it and Chromium would drop every login.
// HEARTH_DATA overrides the profile for smoke and visual tests.
app.setPath('userData',app.isPackaged?path.join(app.getPath('appData'),'Hearth'):(process.env.HEARTH_DATA || path.join(app.getPath('appData'),'Hearth-dev')));
// The smoke test mutates state (lock, sidebar, whiteboard, folders), so it always runs in a fresh throwaway profile.
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
function send(name, value) { if (win && !win.isDestroyed()) win.webContents.send(name, value); }
function touchIDAvailable(){return process.platform==='darwin' && Boolean(systemPreferences.canPromptTouchID?.());}
function scheduleLock(){clearTimeout(lockTimer);if(!config.appLock || locked)return;lockTimer=setTimeout(()=>lockApp(),Math.max(1,Number(config.autoLockMinutes) || 15)*60_000);lockTimer.unref?.();}
function lockApp(){if(!config.appLock || locked)return false;locked=true;hideAllViews();hidePopover();for(const view of win.contentView.children)if(view.webContents?.getURL().endsWith('/document-view.html'))view.setVisible(false);send('app-locked',{locked:true,method:config.appLockMethod});return true;}
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
function sleepSettings(){const s=config.sleep || {};const apps={};for(const [key,value] of Object.entries(s.apps || {}))if(SLEEP_CHOICES.has(value))apps[key]=value;return {defaultMinutes:SLEEP_CHOICES.has(s.defaultMinutes)?s.defaultMinutes:0,apps};}
function sleepMinutesFor(serviceKey){const s=sleepSettings();return serviceKey in s.apps?s.apps[serviceKey]:s.defaultMinutes;}
function stateSnapshot(){if(locked)return {locked:true,lockMethod:config.appLockMethod || 'touchID',theme:config.theme || 'light',version:app.getVersion()};return {locked:false,home:require('node:os').homedir(),root,claudeRoot,claudePolicy:config.claudePolicy || 'notes',claudeWorkspaces:config.claudeWorkspaces || (claudeRoot?[claudeRoot]:[]),connectedFolders:[...new Set([root,...(config.connectedFolders || []),...(config.claudeWorkspaces || [])].filter(Boolean))],services:config.services || [],serviceFolders:config.serviceFolders || [],sidebarOrder:config.sidebarOrder || [],serviceBadges:Object.fromEntries(serviceBadges),tabs:allTabs(),sleep:sleepSettings(),asleep:asleepKeys(),todos:config.todos || [],whiteboard:config.whiteboard || {items:[]},version:app.getVersion(),theme:config.theme || 'light',mode:config.mode || 'chat',layout:config.layout || {},chat:chat.snapshot()};}
function validWhiteboard(value){if(!value || !Array.isArray(value.items) || value.items.length>1000)throw Error('Invalid whiteboard');const camera=value.camera || {x:0,y:0,zoom:1};if(![camera.x,camera.y,camera.zoom].every(Number.isFinite) || camera.zoom<.2 || camera.zoom>3)throw Error('Invalid whiteboard view');const raw=JSON.stringify({items:value.items,camera:{x:camera.x,y:camera.y,zoom:camera.zoom}});if(raw.length>2_000_000)throw Error('Whiteboard is too large');const types=new Set(['path','note','text','rectangle','ellipse','arrow']);for(const item of value.items){if(!item || typeof item.id!=='string' || item.id.length>100 || !types.has(item.type))throw Error('Invalid whiteboard item');}return JSON.parse(raw);}
function validLayout(layout){
 const out={agentCollapsed:Boolean(layout.agentCollapsed),centreCollapsed:Boolean(layout.centreCollapsed),navCollapsed:Boolean(layout.navCollapsed)};
 const tiles=layout.tiles;
 if(tiles && typeof tiles==='object'){
  const mode=['1','2h','2v','4'].includes(tiles.mode)?tiles.mode:'1';
  const slots=Array.from({length:4},(_,i)=>{const slot=Array.isArray(tiles.slots)?tiles.slots[i]:null;return slot && typeof slot.serviceKey==='string' && slot.serviceKey.length<200 && typeof slot.tabId==='string' && slot.tabId.length<100?{serviceKey:slot.serviceKey,tabId:slot.tabId}:null;});
  out.tiles={mode,slots,focus:Number.isInteger(tiles.focus) && tiles.focus>=0 && tiles.focus<4?tiles.focus:0};
 }
 return out;
}
async function clearSessionData(target){await target.clearStorageData();await target.clearCache();await target.clearAuthCache();await target.cookies.flushStore();}
const hardenedSessions=new WeakSet();
function updateAppBadge(){const total=[...serviceBadges.values()].reduce((sum,value)=>sum+value,0);app.setBadgeCount?.(Math.min(9999,total));}
function updateServiceBadge(key,count){if(count)serviceBadges.set(key,count);else serviceBadges.delete(key);updateAppBadge();send('service-badge',{key,count});}
function hardenWebSession(target){
  if(hardenedSessions.has(target))return;
  hardenedSessions.add(target);
  const allowedOrigins=notificationOrigins.get(target) || new Set();notificationOrigins.set(target,allowedOrigins);
  target.setPermissionRequestHandler((contents,permission,callback,details)=>{
    const source=notificationSources.get(contents),origin=details?.requestingUrl || details?.securityOrigin || '',allowed=permission==='notifications' && canNotify(source,contents,origin);
    if(allowed){source.notificationPermission=true;try{allowedOrigins.add(new URL(origin || contents.getURL()).origin);}catch{}}
    callback(allowed);
  });
  target.setPermissionCheckHandler((contents,permission,requestingOrigin)=>{
    if(permission!=='notifications' || !secureOrigin(requestingOrigin))return false;
    if(contents)return canNotify(notificationSources.get(contents),contents,requestingOrigin);
    try{return allowedOrigins.has(new URL(requestingOrigin).origin);}catch{return false;}
  });
  target.setDisplayMediaRequestHandler?.((_request,callback)=>callback({}));
  target.on('will-download',(_event,item)=>{
    item.pause();
    const suggested=item.getFilename().replace(/[\\/\0]/g,'_').slice(0,240) || 'download';
    dialog.showSaveDialog(win,{title:'Save download from Just Zen?',defaultPath:path.join(app.getPath('downloads'),suggested),buttonLabel:'Save'}).then(result=>{
      if(result.canceled || !result.filePath){item.cancel();return;}
      item.setSavePath(result.filePath);item.resume();
    }).catch(()=>item.cancel());
  });
}
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
 return {...result,encrypted:Boolean(secureStore?.available()),profiles,sleep:sleepSettings(),liveViews:views.size,claude:{connected:Boolean(claudeRoot),policy:config.claudePolicy || 'notes',sandboxed:true,terminalSandboxed:false},lock:{enabled:Boolean(config.appLock),locked,touchID:touchIDAvailable(),method:config.appLockMethod || (touchIDAvailable()?'touchID':'passcode'),minutes:Number(config.autoLockMinutes) || 15}};
}
// ---- Apps, tabs and on-screen placement ----
// Browsers are sidebar apps like any other, each with its own isolated profile, tabs, name and icon.
function isBrowserItem(item){return item?.kind==='browser';}
function openable(item){return Boolean(item && (item.url || isBrowserItem(item)));}
function serviceItem(serviceKey){return (config.services || []).find(s=>openable(s) && (s.id || s.url)===serviceKey) || null;}
function cleanEmoji(icon){const value=typeof icon==='string'?icon.trim():'';return [...value].slice(0,4).join('') || '🌐';}
function cleanTabs(serviceKey,raw){
 const item=serviceItem(serviceKey);if(!item)return null;
 const items=(Array.isArray(raw?.items)?raw.items:[]).filter(t=>t && typeof t.id==='string' && t.id.length<100).slice(0,20).map(t=>({id:t.id,url:typeof t.url==='string' && t.url?t.url:'',current:typeof t.current==='string' && t.current?t.current:'',title:typeof t.title==='string'?t.title.slice(0,200):''}));
 if(!items.length)items.push({id:'main',url:isBrowserItem(item)?'':item.url,current:'',title:''});
 return {active:items.some(t=>t.id===raw?.active)?raw.active:items[0].id,items};
}
function tabsFor(serviceKey){config.tabs=config.tabs || {};const clean=cleanTabs(serviceKey,config.tabs[serviceKey]);if(!clean)throw Error('App not found');config.tabs[serviceKey]=clean;return clean;}
function allTabs(){const out={};for(const key of (config.services || []).filter(openable).map(s=>s.id || s.url))out[key]=tabsFor(key);return out;}
function tabOf(serviceKey,tabId){const tab=tabsFor(serviceKey).items.find(t=>t.id===tabId);if(!tab)throw Error('Tab not found');return tab;}
function viewKey(serviceKey,tabId){return serviceKey+'\n'+tabId;}
function asleepKeys(){const out=[];for(const key of Object.keys(config.tabs || {})){const item=serviceItem(key);if(!item || isBrowserItem(item))continue;if(sleepMinutesFor(key)>0 && ![...views.values()].some(v=>v.serviceKey===key))out.push(key);}return out;}
function tabInfo(entry){const c=entry.view.webContents;return {serviceKey:entry.serviceKey,tabId:entry.tabId,url:c.getURL(),title:c.getTitle(),loading:c.isLoading(),canGoBack:c.navigationHistory.canGoBack(),canGoForward:c.navigationHistory.canGoForward()};}
function announceTab(entry){if(entry.view.webContents.isDestroyed())return;send('tab-update',tabInfo(entry));}
function destroyView(key){const entry=views.get(key);if(!entry)return;views.delete(key);try{win.contentView.removeChildView(entry.view);}catch{}try{entry.view.webContents.close();}catch{}}
function closeServiceViews(serviceKey){for(const [key,entry] of views)if(entry.serviceKey===serviceKey)destroyView(key);updateServiceBadge(serviceKey,0);}
function hideAllViews(){for(const entry of views.values())if(entry.visible){entry.view.setVisible(false);entry.visible=false;entry.hiddenSince=Date.now();}}
function preferencesFor(serviceKey){const item=serviceItem(serviceKey);if(!item)throw Error('App not found');return {...(isBrowserItem(item)?browserWebPreferences(serviceKey):webPreferences(item.profile || 'isolated',serviceKey)),backgroundThrottling:false};}
function ensureView(serviceKey,tabId){
  const tab=tabOf(serviceKey,tabId);
  const key=viewKey(serviceKey,tabId);
  const existing=views.get(key);
  if(existing)return existing;
  const url=tab.current || tab.url;
  if(!url)return null;
  const view=new WebContentsView({webPreferences:preferencesFor(serviceKey)});
  const entry=attachView(serviceKey,tabId,view,url);
  view.webContents.loadURL(url).catch(()=>{});
  return entry;
}
// A popup (window.open, target=_blank, OAuth) becomes a new tab in the same pane; Chromium loads it and keeps the opener.
function popupAsTab(serviceKey,options){
  const tabs=tabsFor(serviceKey);if(tabs.items.length>=20)return null;
  const tab={id:crypto.randomUUID(),url:'',current:'',title:''};tabs.items.push(tab);tabs.active=tab.id;persist();
  const view=new WebContentsView({...options,webPreferences:{...(options.webPreferences || {}),...preferencesFor(serviceKey)}});
  const entry=attachView(serviceKey,tab.id,view,'');
  entry.view.webContents.once('destroyed',()=>{views.delete(viewKey(serviceKey,tab.id));const live=tabsFor(serviceKey);const index=live.items.findIndex(t=>t.id===tab.id);if(index<0)return;live.items.splice(index,1);if(!live.items.length)live.items.push({id:crypto.randomUUID(),url:isBrowserItem(serviceItem(serviceKey))?'':serviceItem(serviceKey)?.url || '',current:'',title:''});if(live.active===tab.id)live.active=live.items[Math.max(0,index-1)].id;persist();send('tabs-changed',{serviceKey,tabs:live});});
  send('tab-opened',{serviceKey,tabId:tab.id,tabs});
  return view.webContents;
}
function attachView(serviceKey,tabId,view,url){
  const item=serviceItem(serviceKey);if(!item)throw Error('App not found');
  const key=viewKey(serviceKey,tabId);
  const isBrowser=isBrowserItem(item);
  const preferences=preferencesFor(serviceKey);
  const entry={view,serviceKey,tabId,visible:false,hiddenSince:Date.now()};
  views.set(key,entry);win.contentView.addChildView(view);view.setVisible(false);
  const contents=view.webContents;
  contents.once('destroyed',()=>{if(views.get(key)===entry){views.delete(key);try{win.contentView.removeChildView(view);}catch{}}});
  const notificationSource={contents,saved:!isBrowser,key:serviceKey,name:item.name,notificationPermission:false,badgeInitialized:false,origins:new Set(),landed:false};
  notificationSources.set(contents,notificationSource);
  hardenWebSession(contents.session);
  const origins=notificationOrigins.get(contents.session);try{if(!isBrowser && secureOrigin(url)){origins.add(new URL(url).origin);notificationSource.origins.add(new URL(url).origin);}}catch{}
  configureWebContents(contents,win,message=>send('notice',message),contents,preferences,options=>popupAsTab(serviceKey,options) || undefined);
  attachContextMenu(contents,()=>item.name,params=>params.linkURL && /^https?:/i.test(params.linkURL)?[{label:'Open Link in New Tab',click:()=>openTab(serviceKey,params.linkURL,true)}]:[]);
  contents.on('page-favicon-updated',async (_e,urls)=>{if(!urls.length || isBrowser || bundledIcon(item))return;const icon=await favicon(item.url,urls[0]);if(icon)send('favicon',{url:item.url,icon});});
  // Origins reached by the app's initial redirect chain may notify; later navigations (open redirects, links) may not.
  contents.on('did-navigate',(_e,target)=>{try{if(!isBrowser && !notificationSource.landed && secureOrigin(target)){origins.add(new URL(target).origin);notificationSource.origins.add(new URL(target).origin);}}catch{}try{const live=tabOf(serviceKey,tabId);live.current=target;if(isBrowser && !live.url)live.url=target;persistSoon();}catch{}announceTab(entry);contents.session.cookies.flushStore().catch(()=>{});});
  contents.on('did-navigate-in-page',(_e,_target,isMainFrame)=>{if(isMainFrame)announceTab(entry);});
  for(const event of ['did-start-loading','did-stop-loading'])contents.on(event,()=>announceTab(entry));
  contents.once('did-finish-load',()=>{notificationSource.landed=true;});
  contents.on('did-fail-load',(_e,code,description)=>{if(code!==-3)send('notice','Page could not load: '+description);});
  contents.on('page-title-updated',(_event,title)=>{
    try{const live=tabOf(serviceKey,tabId);live.title=String(title).slice(0,200);persistSoon();}catch{}
    announceTab(entry);
    if(isBrowser)return;
    const count=unreadCount(title),previous=serviceBadges.get(serviceKey) || 0;
    updateServiceBadge(serviceKey,count);
    if(notificationSource.badgeInitialized && count>previous && !notificationSource.notificationPermission && Notification.isSupported()){
      const alert=new Notification({title:item.name,body:count===1?'1 unread message':count+' unread messages',silent:false});
      alert.on('click',()=>{win.show();win.focus();send('open-service',serviceKey);});alert.show();
    }
    notificationSource.badgeInitialized=true;
  });
  send('service-asleep',{key:serviceKey,asleep:false});
  return entry;
}
function clipBounds(box){const [w,h]=win.getContentSize();const x=Math.max(0,Math.min(w,Math.round(box.x))),y=Math.max(0,Math.min(h,Math.round(box.y)));return {x,y,width:Math.max(0,Math.min(w-x,Math.round(box.width))),height:Math.max(0,Math.min(h-y,Math.round(box.height)))};}
function placeViews(list){
  if(!Array.isArray(list) || list.length>4)throw Error('Invalid placement');
  const wanted=new Map();
  for(const p of list){
    if(!p || typeof p.serviceKey!=='string' || typeof p.tabId!=='string' || !['x','y','width','height'].every(k=>Number.isFinite(p[k])))throw Error('Invalid placement');
    let entry=null;try{entry=ensureView(p.serviceKey,p.tabId);}catch{}
    if(entry)wanted.set(viewKey(p.serviceKey,p.tabId),clipBounds(p));
  }
  if(locked)return [];
  for(const [key,entry] of views){
    const box=wanted.get(key);
    if(box){entry.view.setBounds(box);if(!entry.visible){entry.view.setVisible(true);entry.visible=true;entry.hiddenSince=0;}}
    else if(entry.visible){entry.view.setVisible(false);entry.visible=false;entry.hiddenSince=Date.now();}
  }
  return [...wanted.keys()].map(key=>tabInfo(views.get(key)));
}
function openTab(serviceKey,url='',announce=false){
  const item=serviceItem(serviceKey);if(!item)throw Error('App not found');
  const tabs=tabsFor(serviceKey);if(tabs.items.length>=20)throw Error('Close a tab first (20 per app)');
  const target=url?validURL(url):(isBrowserItem(item)?'':item.url);
  const tab={id:crypto.randomUUID(),url:target,current:'',title:''};tabs.items.push(tab);tabs.active=tab.id;persist();
  if(announce)send('tab-opened',{serviceKey,tabId:tab.id,tabs});
  return {serviceKey,tabId:tab.id,tabs};
}
// Hidden apps are put to sleep (their page closed, memory released) after the chosen quiet time; they reload when opened again.
function sleepSweep(){
  if(locked)return;
  const now=Date.now();
  for(const [key,entry] of [...views]){
    const minutes=sleepMinutesFor(entry.serviceKey);
    if(isBrowserItem(serviceItem(entry.serviceKey)) || !minutes || entry.visible || !entry.hiddenSince || now-entry.hiddenSince<minutes*60_000)continue;
    const contents=entry.view.webContents;
    if(contents.isDestroyed()){views.delete(key);continue;}
    if(contents.isCurrentlyAudible())continue;
    destroyView(key);
    if(![...views.values()].some(v=>v.serviceKey===entry.serviceKey))send('service-asleep',{key:entry.serviceKey,asleep:true});
  }
}
function addTask(text){
  const clean=String(text || '').replace(/\s+/g,' ').trim().slice(0,300);if(!clean)throw Error('Enter a task');
  config.todos=config.todos || [];config.todos.push({id:crypto.randomUUID(),text:clean,done:false,createdAt:Date.now()});persist();
  return config.todos;
}
function taskFromSelection(text){try{const todos=addTask(text);send('todos-changed',todos);send('notice','Added to your tasks: '+todos.at(-1).text.slice(0,80));}catch(error){send('notice',error.message);}}
// Right-click menu for any pane: send the selection to the Claude context card or straight to Tasks, plus the usual editing items.
function attachContextMenu(contents,sourceName,extra=()=>[]){
  contents.on('context-menu',(_event,params)=>{
    if(locked)return;
    const text=String(params.selectionText || '').trim(),items=[];
    if(text)items.push({label:'Send Selection to Claude',click:()=>send('claude-context',{text:text.slice(0,20000),source:sourceName()})},{label:'Send Selection to Tasks',click:()=>taskFromSelection(text)});
    items.push(...extra(params,text));
    if(items.length)items.push({type:'separator'});
    if(params.isEditable)items.push({role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'});
    else if(text)items.push({role:'copy'});
    if(params.linkURL)items.push({label:'Copy Link',click:()=>clipboard.writeText(params.linkURL)});
    if(items.length && items.at(-1).type==='separator')items.pop();
    if(items.length)Menu.buildFromTemplate(items).popup({window:win});
  });
}
// ---- Group popover: a small frameless window beside the sidebar, above the web views ----
let popover=null,popoverFolder=null;
async function iconFor(item){const local=bundledIcon(item);if(local)return 'data:image/png;base64,'+(await fs.readFile(path.join(__dirname,local))).toString('base64');try{return item?.url?await favicon(item.url):null;}catch{return null;}}
function ensurePopover(){
  if(popover && !popover.isDestroyed())return popover;
  popover=new BrowserWindow({parent:win,show:false,frame:false,transparent:true,hasShadow:false,resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,width:560,height:200,webPreferences:{preload:path.join(__dirname,'popover-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,partition:'popover',backgroundThrottling:false}});
  popover.setWindowButtonVisibility?.(false);
  const pc=popover.webContents;
  pc.session.setPermissionRequestHandler((_c,_p,done)=>done(false));pc.session.setPermissionCheckHandler(()=>false);
  const allowed=new Set(['popover.html','popover.css','popover.js'].map(f=>pathToFileURL(path.join(__dirname,f)).href));
  pc.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowed.has(details.url)}));
  pc.setWindowOpenHandler(()=>({action:'deny'}));pc.on('will-navigate',e=>e.preventDefault());
  popover.on('blur',()=>hidePopover());
  popover.on('closed',()=>{popover=null;});
  pc.loadFile('popover.html');
  return popover;
}
function popoverTrusted(e){if(!popover || popover.isDestroyed() || e.sender!==popover.webContents)throw Error('Untrusted popover request');}
function hidePopover(){popoverFolder=null;if(popover && !popover.isDestroyed() && popover.isVisible())popover.hide();}
async function showPopover({folderId,left,top}){
  const folder=(config.serviceFolders || []).find(f=>f.id===folderId);if(!folder)throw Error('Group not found');
  const members=(config.services || []).filter(s=>openable(s) && s.folderId===folderId);
  const items=await Promise.all(members.map(async item=>({key:item.id || item.url,name:item.name,icon:isBrowserItem(item)?null:await iconFor(item),emoji:isBrowserItem(item)?item.icon || '🌐':null,badge:serviceBadges.get(item.id || item.url) || 0})));
  const window_=ensurePopover();popoverFolder=folderId;
  if(window_.webContents.isLoading())await new Promise(resolve=>window_.webContents.once('did-finish-load',resolve));
  const cb=win.getContentBounds();
  window_.__anchor={x:cb.x+Math.round(left),y:cb.y+Math.round(top)};
  window_.webContents.send('popover-show',{folder,items,theme:config.theme || 'light'});
  return true;
}
function placePopover(size){
  if(!popover || popover.isDestroyed() || !popoverFolder)return;
  const {x,y}=popover.__anchor || {x:0,y:0};const {x:wx,y:wy,width:ww,height:wh}=win.getContentBounds();
  const width=Math.max(160,Math.min(620,Math.round(size.width))),height=Math.max(80,Math.min(wh,Math.round(size.height)));
  popover.setBounds({x:Math.max(wx,Math.min(x,wx+ww-width)),y:Math.max(wy,Math.min(y-10,wy+wh-height)),width,height});
  if(!popover.isVisible())popover.show();else popover.focus();
}
function subscriptionEnv(){
  const env={...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',PATH:'/opt/homebrew/bin:/usr/local/bin:'+process.env.PATH,CLAUDE_CONFIG_DIR:claudeConfigDir};
  delete env.ELECTRON_RUN_AS_NODE;
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[key];
  return env;
}
function startTerminal(kind = 'claude') {
  if (kind!=='login' && !claudeRoot) throw Error('Choose a Claude workspace first');
  if(kind==='claude' && (config.claudePolicy || 'notes')!=='full')throw Error('Claude Terminal requires Full workspace mode. Use Chat for enforced Read-only or Notes-only access.');
  if (terminal) throw Error('A session is already running. Stop it before starting another.');
  if(chat?.state.busy)throw Error('Stop the chat turn before starting a terminal');
  const env=subscriptionEnv();
  // 'login' runs the CLI's browser sign-in against Just Zen's own Claude config directory.
  terminal = pty.spawn(kind === 'shell' ? '/bin/zsh' : findClaude(), kind === 'shell' ? ['-l'] : kind==='login' ? ['auth','login','--claudeai'] : [], {name:'xterm-256color',cols:70,rows:32,cwd:claudeRoot || app.getPath('userData'),env});
  const current = terminal;
  current.onData(data => send('terminal-data',data));
  current.onExit(({exitCode}) => { if(terminal === current) terminal = null; send('terminal-exit',exitCode); });
  return true;
}
app.whenReady().then(async () => {
  secureStore=createSecureStore({fs,safeStorage,userData:app.getPath('userData')});
  try { config = await secureStore.load(); if(config.root) root = await fs.realpath(config.root);if(config.claudeRoot)claudeRoot=await fs.realpath(config.claudeRoot);else if(root){claudeRoot=root;config.claudeRoot=root;}if(claudeRoot)config.claudeWorkspaces=[claudeRoot,...(config.claudeWorkspaces || []).filter(value=>value!==claudeRoot)].slice(0,12); } catch(error){console.error(error);config={};}
  if(!(config.services || []).some(isBrowserItem)){config.services=[{id:BROWSER_KEY,kind:'browser',name:'Browser',icon:'🌐',profile:'isolated'},...(config.services || [])];if(Array.isArray(config.sidebarOrder) && config.sidebarOrder.length)config.sidebarOrder=[BROWSER_KEY,...config.sidebarOrder.filter(e=>e!==BROWSER_KEY)];await persist();}
  const unprofiled=(config.services || []).some(item=>item.url && !item.profile);if(unprofiled){config.services=config.services.map(item=>item.url && !item.profile?{...item,profile:'isolated'}:item);await persist();}
  if(!config.whiteboard && Array.isArray(config.stickyNotes)){config.whiteboard={items:config.stickyNotes.map((note,index)=>({id:note.id || crypto.randomUUID(),type:'note',x:80+(index%4)*245,y:90+Math.floor(index/4)*195,w:220,h:170,text:String(note.text || ''),color:{sun:'#fff0a8',blue:'#dcecff',mint:'#dff2df',rose:'#f7dfe5'}[note.color] || '#fff0a8',rotation:(index%2?1:-1)*.6}))};delete config.stickyNotes;await persist();}
  locked=Boolean(config.appLock);
  favicon=createFaviconCache(path.join(app.getPath('userData'),'favicons'),net,createImageDecoder({BrowserWindow}));
  nativeTheme.themeSource=config.theme || 'light';
  chat=new ChatSession({claudePath:findClaude(),emit:state=>send('chat-state',state),policy:()=>({mode:config.claudePolicy || 'notes',root:claudeRoot}),env:()=>({...subscriptionEnv(),ANTHROPIC_API_KEY:undefined,ANTHROPIC_AUTH_TOKEN:undefined,ANTHROPIC_BASE_URL:undefined,CLAUDE_CODE_USE_BEDROCK:undefined,CLAUDE_CODE_USE_VERTEX:undefined,CLAUDE_CODE_USE_FOUNDRY:undefined}),save:async state=>{if(!claudeRoot)return;config.chats=config.chats || {};config.chats[claudeRoot]=state;await persist();}});
  chat.restore(config.chats?.[claudeRoot]);
  win = new BrowserWindow({show:false,width:1440,height:940,minWidth:1100,minHeight:700,title:'Just Zen',icon:path.join(__dirname,'assets','justzen.png'),titleBarStyle:'hiddenInset',backgroundColor:'#ffffff',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  // Send the current selection, wherever the focus is, to the Claude context card or to Tasks. Nothing is sent to Claude until the user picks an action.
  async function sendSelectionTo(target){
    if(locked)return;
    const focused=webContents.getFocusedWebContents();
    if(!focused || focused===win.webContents){send('capture-selection',{target});return;}
    if(focused===dc){dc.send('capture-selection',target);return;}
    for(const entry of views.values())if(entry.view.webContents===focused){
      let text='';try{text=String(await focused.executeJavaScript('String(window.getSelection ? window.getSelection().toString() : "")',true)).slice(0,20000);}catch{}
      if(!text.trim()){send('notice','Select some text first, then press '+(target==='task'?'⌘⇧T.':'⌘⇧A.'));return;}
      if(target==='task')taskFromSelection(text);else send('claude-context',{text,source:notificationSources.get(focused)?.name || 'the web app'});return;
    }
    send('capture-selection',{target});
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Just Zen',submenu:[{role:'about'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'Go',submenu:[{label:'Command Palette',accelerator:'CmdOrCtrl+Shift+P',click:()=>{if(!locked)send('open-palette',true);}},{label:'Send Selection to Claude',accelerator:'CmdOrCtrl+Shift+A',click:()=>sendSelectionTo('claude')},{label:'Send Selection to Tasks',accelerator:'CmdOrCtrl+Shift+T',click:()=>sendSelectionTo('task')},{type:'separator'},{label:'New Tab',accelerator:'CmdOrCtrl+T',click:()=>{if(!locked)send('tab-command','new');}},{label:'Close Tab',accelerator:'CmdOrCtrl+W',click:()=>{if(!locked)send('tab-command','close');}},{label:'Reload Tab',accelerator:'CmdOrCtrl+R',click:()=>{if(!locked)send('tab-command','reload');}},{label:'Address Bar',accelerator:'CmdOrCtrl+L',click:()=>{if(!locked)send('tab-command','address');}}]},{label:'View',submenu:[{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]}]));
  win.webContents.on('will-navigate', e => e.preventDefault());
  attachContextMenu(win.webContents,()=>'your workspace');
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.on('closed',() => { terminal?.kill();chat.stop();for(const key of [...views.keys()])destroyView(key); });
  const documents=require('./documents.cjs').createDocuments(dialog,()=>win);
  const documentEntry=require('node:url').pathToFileURL(path.join(__dirname,'document-view.html')).href;
  const documentView=new WebContentsView({webPreferences:{preload:path.join(__dirname,'document-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'documents-preview'}});
  win.contentView.addChildView(documentView);documentView.setVisible(false);
  const dc=documentView.webContents;
  dc.session.setPermissionRequestHandler((_c,_p,done)=>done(false));dc.session.setPermissionCheckHandler(()=>false);
  const allowedDocumentFiles=new Set(['document-view.html','document-view.css','style.css','document-view.js','document-pane.js','node_modules/dompurify/dist/purify.min.js','node_modules/pdfjs-dist/build/pdf.mjs','node_modules/pdfjs-dist/build/pdf.worker.mjs'].map(f=>require('node:url').pathToFileURL(path.join(__dirname,f)).href));
  dc.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowedDocumentFiles.has(details.url)}));
  attachContextMenu(dc,()=>'the document',()=>[{label:'Send This Page to Claude',click:()=>dc.send('capture-selection','claude')}]);
  dc.setWindowOpenHandler(()=>({action:'deny'}));dc.on('will-navigate',e=>e.preventDefault());dc.on('will-frame-navigate',e=>e.preventDefault());dc.on('will-redirect',e=>e.preventDefault());
  function documentTrusted(e){if(locked || e.sender!==dc || e.senderFrame!==dc.mainFrame || e.senderFrame.url!==documentEntry)throw Error('Untrusted document request');}
  for(const [name,fn] of [['document-open',()=>documents.open()],['document-save',input=>documents.save(input)],['document-close',()=>documents.close()]])ipcMain.handle(name,(e,...args)=>{documentTrusted(e);return fn(...args);});
  ipcMain.on('document-collapse',e=>{try{documentTrusted(e);documentView.setVisible(false);send('document-collapse');}catch{}});
  ipcMain.on('document-selection',(e,payload)=>{try{documentTrusted(e);const text=payload?.text;if(typeof text!=='string' || !text.trim())return;if(payload.target==='task')taskFromSelection(text);else send('claude-context',{text:text.slice(0,20000),source:'the document'});}catch{}});
  handle('show-group-popover',input=>{if(!input || typeof input.folderId!=='string' || !Number.isFinite(input.left) || !Number.isFinite(input.top))throw Error('Invalid popover request');return showPopover(input);});
  handle('hide-group-popover',()=>{hidePopover();return true;});
  ipcMain.on('popover-size',(e,size)=>{try{popoverTrusted(e);if(size && Number.isFinite(size.width) && Number.isFinite(size.height))placePopover(size);}catch{}});
  ipcMain.on('popover-open',(e,key)=>{try{popoverTrusted(e);hidePopover();if(typeof key==='string' && (config.services || []).some(s=>(s.id || s.url)===key))send('open-service',key);}catch{}});
  ipcMain.on('popover-edit',(e,id)=>{try{popoverTrusted(e);hidePopover();if(typeof id==='string' && (config.serviceFolders || []).some(f=>f.id===id))send('edit-group',id);}catch{}});
  ipcMain.on('popover-close',e=>{try{popoverTrusted(e);hidePopover();}catch{}});
  ipcMain.on('popover-remove',async (e,input)=>{try{popoverTrusted(e);if(!input || typeof input.key!=='string' || typeof input.folderId!=='string')return;config.services=setFolder(config.services || [],input.key,null,config.serviceFolders || []);await persist();send('sidebar-changed',{services:config.services,folders:config.serviceFolders || []});const cb=win.getContentBounds();await showPopover({folderId:input.folderId,left:popover.__anchor.x-cb.x,top:popover.__anchor.y-cb.y});}catch{}});
  win.on('move',()=>hidePopover());win.on('resize',()=>hidePopover());
  handle('document-bounds',box=>{const [w,h]=win.getContentSize();if(!box || !['x','y','width','height'].every(k=>Number.isFinite(box[k])))throw Error('Invalid document bounds');const x=Math.max(0,Math.min(w,Math.round(box.x))),y=Math.max(0,Math.min(h,Math.round(box.y)));documentView.setBounds({x,y,width:Math.max(0,Math.min(w-x,Math.round(box.width))),height:Math.max(0,Math.min(h-y,Math.round(box.height)))});documentView.setVisible(Boolean(box.visible)&&!locked);});
  dc.loadURL(documentEntry);
  handle('state',stateSnapshot);
  handle('security-status',securityStatus);
  handle('unlock-app',async passcode=>{if(!locked)return stateSnapshot();await unlockAuthentication(passcode);locked=false;scheduleLock();send('app-locked',{locked:false});return stateSnapshot();});
  handle('lock-app',()=>lockApp());
  handle('app-activity',()=>{scheduleLock();return true;});
  handle('set-app-lock',async ({enabled,minutes,passcode})=>{if(typeof enabled!=='boolean')throw Error('Invalid lock setting');if(enabled && !config.appLock){if(touchIDAvailable()){await authenticate('Enable the Just Zen app lock');config.appLockMethod='touchID';delete config.lockSalt;delete config.lockHash;}else{if(typeof passcode!=='string' || passcode.length<6 || passcode.length>128)throw Error('Choose a passcode between 6 and 128 characters');const salt=crypto.randomBytes(16);config.appLockMethod='passcode';config.lockSalt=salt.toString('base64');config.lockHash=passcodeHash(passcode,salt).toString('base64');}}if(!enabled){delete config.appLockMethod;delete config.lockSalt;delete config.lockHash;}config.appLock=enabled;config.autoLockMinutes=Math.max(1,Math.min(120,Number(minutes) || 15));await persist();if(enabled)scheduleLock();else clearTimeout(lockTimer);return securityStatus();});
  handle('choose-folder',async () => {
    if(terminal || chat.state.busy) throw Error('Stop the current session before changing folders');
    hideAllViews();
    const result = await dialog.showOpenDialog(win,{title:'Connect a local folder for Files and Claude',properties:['openDirectory']});
    if(result.canceled) return null;
    const selected=await fs.realpath(result.filePaths[0]);config.connectedFolders=[...new Set([selected,root,...(config.connectedFolders || []),...(config.claudeWorkspaces || [])].filter(Boolean))];root=selected;config.root=root;claudeRoot=root;config.claudeRoot=root;config.claudeWorkspaces=[...new Set([root,...(config.claudeWorkspaces || [])])];chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return root;
  });
  handle('select-files-folder',async value=>{if(terminal || chat.state.busy)throw Error('Stop Claude before changing folders');if(!stateSnapshot().connectedFolders.includes(value))throw Error('Unknown folder');const selected=await fs.realpath(value);root=selected;config.root=root;claudeRoot=root;config.claudeRoot=root;config.claudeWorkspaces=[...new Set([root,...(config.claudeWorkspaces || [])])];chat.restore(config.chats?.[root]);chat.publish();await persist();return stateSnapshot();});
  handle('choose-claude-folder',async () => {
    if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing its workspace');
    const result=await dialog.showOpenDialog(win,{title:'Choose the folder Claude may access',properties:['openDirectory']});
    if(result.canceled)return null;
    claudeRoot=await fs.realpath(result.filePaths[0]);config.claudeRoot=claudeRoot;config.claudeWorkspaces=[claudeRoot,...(config.claudeWorkspaces || []).filter(value=>value!==claudeRoot)].slice(0,12);chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return {root:claudeRoot,policy:config.claudePolicy || 'notes',workspaces:config.claudeWorkspaces};
  });
  handle('select-claude-folder',async value=>{if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing its workspace');if(typeof value!=='string' || !(config.claudeWorkspaces || []).includes(value))throw Error('Unknown Claude workspace');claudeRoot=await fs.realpath(value);config.claudeRoot=claudeRoot;chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return {root:claudeRoot,policy:config.claudePolicy || 'notes',workspaces:config.claudeWorkspaces};});
  handle('disconnect-claude-folder',async ()=>{if(terminal || chat.state.busy)throw Error('Stop the current Claude session before disconnecting its workspace');claudeRoot=null;delete config.claudeRoot;chat.restore(null);chat.publish();await persist();return true;});
  handle('set-claude-policy',async mode=>{if(!['full','notes','readOnly'].includes(mode))throw Error('Invalid Claude access mode');if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing access');config.claudePolicy=mode;await persist();return mode;});
  handle('appearance',async ({theme,mode,layout})=>{if(theme && !['light','dark'].includes(theme))throw Error('Invalid theme');if(mode && !['chat','terminal'].includes(mode))throw Error('Invalid mode');if(layout && typeof layout==='object')config.layout=validLayout(layout);if(theme){config.theme=theme;nativeTheme.themeSource=theme;}if(mode)config.mode=mode;await persist();return true;});
  handle('chat-send',async prompt=>{if(!claudeRoot)throw Error('Choose a Claude workspace first');if(terminal)throw Error('Stop the terminal session before sending a chat message');if(chat.state.busy)throw Error('Wait for the current reply');const sandbox=await prepareClaudeSandbox({fs,root:claudeRoot,mode:config.claudePolicy || 'notes',userData:app.getPath('userData'),packageRoot:__dirname,nodePath:findNode(),claudePath:findClaude(),configDir:claudeConfigDir});chat.run(prompt,claudeRoot,sandbox.executable).catch(error=>send('notice',error.message));return true;});
  handle('chat-stop',()=>chat.stop());
  handle('claude-logout',async()=>{if(terminal || chat.state.busy)throw Error('Stop Claude before signing out');try{await execFile(findClaude(),['auth','logout'],{env:subscriptionEnv(),timeout:15000});}catch(error){if(!/not logged in/i.test(String(error.stdout || '')+String(error.stderr || '')))throw Error('Sign-out failed: '+String(error.stderr || error.message).trim().slice(0,200));}chat.restore(null);chat.publish();config.chats={};await persist();return true;});
  handle('claude-auth-status',async()=>{let auth={loggedIn:false};try{auth=JSON.parse((await execFile(findClaude(),['auth','status','--json'],{env:subscriptionEnv(),timeout:15000})).stdout);}catch(error){try{auth=JSON.parse(String(error.stdout || '{}'));}catch{}}return {loggedIn:Boolean(auth.loggedIn && auth.authMethod==='claude.ai'),installed:!(auth.loggedIn===false && !auth.authMethod && false)};});
  handle('chat-permission',value=>chat.respond(value));
  handle('chat-new',async ()=>{if(chat.state.busy)throw Error('Stop the current reply first');chat.restore(null);chat.publish();config.chats=config.chats || {};delete config.chats[claudeRoot];await persist();});
  handle('files',files);
  handle('search-notes',async query=>{if(!root || typeof query!=='string')return [];const q=query.trim().toLowerCase();if(q.length<2)return [];const out=[];let count=0;async function walk(dir){if(out.length>=30 || ++count>1500)return;for(const item of await files(dir).catch(()=>[])){if(out.length>=30)return;if(item.folder)await walk(item.path);else if(/\.(md|markdown|txt)$/i.test(item.name) && item.path.toLowerCase().includes(q))out.push(item.path);}}await walk('');return out;});
  handle('read',async relative => { const file = await localFile(relative); const stat = await fs.stat(file); if(stat.size > 2e6) throw Error('Preview supports text files up to 2 MB'); const text = await fs.readFile(file,'utf8'); if(text.includes('\0')) throw Error('This is a binary file'); return {text}; });
  handle('save',async ({relative,text,original}) => { if(typeof text !== 'string' || text.length > 2e6) throw Error('Invalid file content'); const file = await localFile(relative); if(await fs.readFile(file,'utf8') !== original) throw Error('This file changed on disk. Reopen it before saving.'); await fs.writeFile(file,text); return true; });
  handle('resolve-note',async ({target,from})=>{if(typeof target!=='string' || target.length>1000)throw Error('Invalid note link');const name=/\.md$/i.test(target)?target:target+'.md';for(const candidate of [path.join(path.dirname(from || ''),name),name]){try{const file=await localFile(candidate);if((await fs.stat(file)).isFile())return path.relative(root,file);}catch{}}let count=0;async function search(dir=''){if(++count>2000)return null;for(const item of await files(dir)){if(item.folder){const found=await search(item.path);if(found)return found;}else if(item.name.toLowerCase()===path.basename(name).toLowerCase())return item.path;}return null;}const found=await search();if(!found)throw Error('Note not found: '+target);return found;});
  // Tabs and placement: the renderer owns the layout; the main process owns the pages.
  handle('place-views',list=>placeViews(list));
  handle('tabs',()=>allTabs());
  handle('open-tab',({serviceKey,url}={})=>openTab(serviceKey,typeof url==='string'?url:''));
  handle('activate-tab',async ({serviceKey,tabId}={})=>{const tabs=tabsFor(serviceKey);tabOf(serviceKey,tabId);tabs.active=tabId;await persist();return tabs;});
  handle('close-tab',async ({serviceKey,tabId}={})=>{const tabs=tabsFor(serviceKey);const index=tabs.items.findIndex(t=>t.id===tabId);if(index<0)throw Error('Tab not found');destroyView(viewKey(serviceKey,tabId));tabs.items.splice(index,1);if(!tabs.items.length)tabs.items.push({id:crypto.randomUUID(),url:isBrowserItem(serviceItem(serviceKey))?'':serviceItem(serviceKey).url,current:'',title:''});if(tabs.active===tabId)tabs.active=tabs.items[Math.min(index,tabs.items.length-1)].id;await persist();return tabs;});
  handle('navigate-tab',async ({serviceKey,tabId,url}={})=>{const tab=tabOf(serviceKey,tabId);const target=validURL(url);tab.current=target;if(!tab.url)tab.url=target;tab.title='';await persist();const entry=views.get(viewKey(serviceKey,tabId));if(entry)entry.view.webContents.loadURL(target).catch(()=>{});else ensureView(serviceKey,tabId);return tabsFor(serviceKey);});
  handle('tab-action',({serviceKey,tabId,action}={})=>{tabOf(serviceKey,tabId);const entry=views.get(viewKey(serviceKey,tabId));if(!entry)return false;const c=entry.view.webContents;if(action==='back' && c.navigationHistory.canGoBack())c.navigationHistory.goBack();else if(action==='forward' && c.navigationHistory.canGoForward())c.navigationHistory.goForward();else if(action==='reload')c.reload();else if(action==='stop')c.stop();else if(action==='home'){const tab=tabOf(serviceKey,tabId);if(tab.url)c.loadURL(tab.url).catch(()=>{});}else if(action==='focus')c.focus();return tabInfo(entry);});
  handle('set-sleep',async ({defaultMinutes,key,minutes}={})=>{const s=sleepSettings();if(defaultMinutes!==undefined){if(!SLEEP_CHOICES.has(defaultMinutes))throw Error('Invalid sleep delay');s.defaultMinutes=defaultMinutes;}if(typeof key==='string'){if(!serviceItem(key) || isBrowserItem(serviceItem(key)))throw Error('App not found');if(minutes===null || minutes===undefined)delete s.apps[key];else if(SLEEP_CHOICES.has(minutes))s.apps[key]=minutes;else throw Error('Invalid sleep delay');}config.sleep=s;await persist();return s;});
  handle('set-service-profile',async ({key,profile})=>{if(!PROFILES.has(profile))throw Error('Invalid browser profile');let found=false;config.services=(config.services || []).map(item=>{if((item.id || item.url)!==key)return item;found=true;return {...item,profile};});if(!found)throw Error('App not found');closeServiceViews(key);await persist();return config.services;});
  handle('isolate-all-services',async()=>{for(const item of config.services || [])if(item.url)closeServiceViews(item.id || item.url);config.services=(config.services || []).map(item=>item.url?{...item,profile:'isolated'}:item);await persist();return config.services;});
  handle('clear-profile-data',async ({profile,key})=>{if(profile==='browser'){const item=serviceItem(key);if(!isBrowserItem(item))throw Error('Browser not found');closeServiceViews(key);delete (config.tabs || {})[key];await clearSessionData(session.fromPartition(browserPartition(key)));await persist();return true;}if(!PROFILES.has(profile))throw Error('Invalid browser profile');if(profile==='isolated' && !(config.services || []).some(item=>(item.id || item.url)===key))throw Error('App not found');for(const item of config.services || [])if(item.url && (item.profile || 'isolated')===profile && (profile!=='isolated' || (item.id || item.url)===key))closeServiceViews(item.id || item.url);await clearSessionData(session.fromPartition(partitionFor(profile,key)));return true;});
  handle('clear-claude-history',async()=>{if(chat.state.busy)throw Error('Stop Claude before clearing history');config.chats={};chat.restore(null);chat.publish();await persist();return true;});
  handle('erase-hearth-data',async()=>{if(chat.state.busy || terminal)throw Error('Stop Claude before erasing Just Zen data');const partitions=new Set([partitionFor('shared'),partitionFor('personal'),partitionFor('work'),BROWSER_PARTITION]);for(const item of config.services || []){if(isBrowserItem(item))partitions.add(browserPartition(item.id));else if(item.url)partitions.add(partitionFor(item.profile || 'isolated',item.id || item.url));}for(const key of [...views.keys()])destroyView(key);for(const name of partitions)await clearSessionData(session.fromPartition(name));config={theme:config.theme || 'light'};root=null;claudeRoot=null;chat.restore(null);chat.publish();await fs.rm(path.join(app.getPath('userData'),'favicons'),{recursive:true,force:true});await fs.rm(path.join(app.getPath('userData'),'claude-sandbox'),{recursive:true,force:true});await fs.rm(claudeConfigDir,{recursive:true,force:true});
  // Remove on-disk partitions left by earlier builds that persisted ad-hoc addresses.
  const known=new Set([...partitions].map(name=>name.replace(/^persist:/,'')));const partitionRoot=path.join(app.getPath('userData'),'Partitions');for(const entry of await fs.readdir(partitionRoot,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory() && !known.has(decodeURIComponent(entry.name)))await fs.rm(path.join(partitionRoot,entry.name),{recursive:true,force:true});
  await persist();send('data-erased',true);return stateSnapshot();});
  handle('reorder-services',async keys=>{config.services=reorder(config.services || [],keys);await persist();return config.services;});
  // One ordering for the whole sidebar: 'group:<id>' entries and app keys, as the user arranged them.
  handle('reorder-sidebar',async entries=>{
    if(!Array.isArray(entries) || entries.length>300)throw Error('Invalid sidebar order');
    const folders=config.serviceFolders || [],apps=(config.services || []).filter(openable);
    const clean=[];const seen=new Set();
    for(const entry of entries){if(typeof entry!=='string' || seen.has(entry))continue;if(entry.startsWith('group:')?folders.some(f=>f.id===entry.slice(6)):apps.some(s=>(s.id || s.url)===entry)){clean.push(entry);seen.add(entry);}}
    const groupOrder=clean.filter(e=>e.startsWith('group:')).map(e=>e.slice(6));
    config.serviceFolders=[...groupOrder.map(id=>folders.find(f=>f.id===id)),...folders.filter(f=>!groupOrder.includes(f.id))];
    const appOrder=clean.filter(e=>!e.startsWith('group:'));
    config.services=[...appOrder.map(key=>apps.find(s=>(s.id || s.url)===key)),...(config.services || []).filter(s=>!openable(s) || !appOrder.includes(s.id || s.url))];
    config.sidebarOrder=clean;await persist();return {services:config.services,folders:config.serviceFolders,order:config.sidebarOrder};
  });
  handle('create-service-folder',async ({name,icon,keys}={})=>{const id=crypto.randomUUID();config.serviceFolders=createFolder(config.serviceFolders || [],name,id,icon);if(Array.isArray(keys))for(const key of keys.slice(0,100))if(typeof key==='string')try{config.services=setFolder(config.services || [],key,id,config.serviceFolders);}catch{}await persist();return {services:config.services || [],folders:config.serviceFolders};});
  handle('update-service-folder',async ({id,name,icon}={})=>{config.serviceFolders=updateFolder(config.serviceFolders || [],id,{name,icon});await persist();return {services:config.services || [],folders:config.serviceFolders};});
  handle('remove-service-folder',async id=>{const next=removeFolder(config.services || [],config.serviceFolders || [],id);config.services=next.services;config.serviceFolders=next.folders;await persist();return {services:config.services,folders:config.serviceFolders};});
  handle('set-service-folder',async ({key,folderId})=>{config.services=setFolder(config.services || [],key,folderId,config.serviceFolders || []);await persist();return {services:config.services,folders:config.serviceFolders || []};});
  handle('toggle-service-folder',async id=>{let found=false;config.serviceFolders=(config.serviceFolders || []).map(folder=>{if(folder.id!==id)return folder;found=true;return {...folder,collapsed:!folder.collapsed};});if(!found)throw Error('Group not found');await persist();return {services:config.services || [],folders:config.serviceFolders};});
  handle('add-todo',async text=>{if(typeof text!=='string' || !text.trim())throw Error('Enter a task');addTask(text);await persist();return config.todos;});
  handle('toggle-todo',async id=>{let found=false;config.todos=(config.todos || []).map(todo=>{if(todo.id!==id)return todo;found=true;const done=!todo.done;return {...todo,done,doneAt:done?Date.now():null};});if(!found)throw Error('Task not found');await persist();return config.todos;});
  handle('save-whiteboard',async value=>{config.whiteboard=validWhiteboard(value);await persist();return true;});
  handle('favicon',async key=>{const item=(config.services || []).find(s=>(s.id || s.url)===key);const local=bundledIcon(item);if(local)return 'data:image/png;base64,'+(await fs.readFile(path.join(__dirname,local))).toString('base64');return item?.url?favicon(item.url):null;});
  handle('web-apps',()=>catalogue.map(item=>({...item,added:isAdded(config.services || [],item)})));
  handle('add-catalog-app',async id=>{config.services=addApp(config.services || [],id);await persist();return config.services;});
  handle('remove-service',async key=>{closeServiceViews(key);config.services=(config.services || []).filter(s=>(s.id || s.url)!==key);delete (config.tabs || {})[key];if(config.sleep?.apps)delete config.sleep.apps[key];await persist();return config.services;});
  handle('add-browser',async ({name,icon}={})=>{if(typeof name!=='string' || !name.trim())throw Error('Name is required');config.services=config.services || [];const item={id:crypto.randomUUID(),kind:'browser',name:name.trim().slice(0,50),icon:cleanEmoji(icon),profile:'isolated'};config.services.push(item);await persist();return {services:config.services,key:item.id};});
  handle('update-service',async ({key,name,icon}={})=>{let found=false;config.services=(config.services || []).map(item=>{if((item.id || item.url)!==key)return item;found=true;const next={...item};if(typeof name==='string' && name.trim())next.name=name.trim().slice(0,50);if(icon!==undefined && isBrowserItem(item))next.icon=cleanEmoji(icon);return next;});if(!found)throw Error('App not found');await persist();return config.services;});
  handle('add-service',async ({name,url}) => { url = validURL(url); if(typeof name !== 'string' || !name.trim()) throw Error('Name is required'); config.services=config.services || [];if(!config.services.some(s=>s.url===url))config.services.push({id:require('node:crypto').randomUUID(),name:name.trim().slice(0,50),kind:'web',url,profile:'isolated'}); await persist(); return config.services; });
  handle('start-terminal',kind => { if(!['claude','shell','login'].includes(kind)) throw Error('Invalid session'); return startTerminal(kind); });
  handle('stop-terminal',() => { terminal?.kill(); });
  handle('terminal-input',data => { if(typeof data === 'string' && data.length < 100000) terminal?.write(data); });
  handle('terminal-size',({cols,rows}) => { if(Number.isInteger(cols) && Number.isInteger(rows) && cols>0 && rows>0 && cols<1000 && rows<1000) terminal?.resize(cols,rows); });
  await win.loadFile('index.html');
  if(locked)await win.webContents.executeJavaScript("document.body.classList.add('is-locked');document.getElementById('lock-screen').classList.remove('hidden')");
  win.show();
  if(!locked)scheduleLock();
  const updates=startAutoUpdates(message=>send('notice',message),version=>send('update-ready',version));
  handle('install-update',()=>{if(!updates.install)throw Error('No update is ready');updates.install();return true;});
  const sleeper=setInterval(sleepSweep,30_000);sleeper.unref?.();
  if(!smoke){let index=0;const warm=()=>{if(!win || win.isDestroyed())return;const sites=(config.services || []).filter(s=>s.url);if(index>=sites.length)return;if(!locked){const item=sites[index++];const key=item.id || item.url;try{const tabs=tabsFor(key);ensureView(key,tabs.active);}catch{}}setTimeout(warm,1500);};setTimeout(warm,1500);}
  if(smoke) {
    try {
      for(const item of require('./app-catalog.cjs').catalogue){if(nativeImage.createFromPath(path.join(__dirname,item.icon)).isEmpty())throw Error('Invalid bundled icon: '+item.name);}
      root = path.join(__dirname,'smoke-vault');claudeRoot=root; await fs.mkdir(root,{recursive:true}); await fs.writeFile(path.join(root,'Welcome.md'),'# Test vault\n');
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
        if(locked)throw Error('Passcode lock did not unlock');
      }
      await win.webContents.executeJavaScript(`(async()=>{const board={items:[{id:'smoke-note',type:'note',x:20,y:20,w:220,h:170,text:'Remember this',color:'#fff0a8'}],camera:{x:-400,y:250,zoom:.75}};await window.hearth.call('save-whiteboard',board);const state=await window.hearth.call('state');if(state.whiteboard.items[0].text!=='Remember this' || state.whiteboard.camera.x!==-400 || state.whiteboard.camera.zoom!==.75)throw Error('Infinite whiteboard did not persist');await window.hearth.call('save-whiteboard',{items:[],camera:{x:0,y:0,zoom:1}});})()`);
      await win.webContents.executeJavaScript(`(async()=>{
        const text=(await window.hearth.call('read','Welcome.md')).text;
        await window.hearth.call('save',{relative:'Welcome.md',text:text+'Saved.',original:text});
        let conflict=false;try{await window.hearth.call('save',{relative:'Welcome.md',text:'Wrong',original:text});}catch{conflict=true;}
        if(!conflict)throw Error('Stale save was accepted');
      })()`);
      // Tabs, groups and placement round-trip through the same IPC the renderer uses.
      await win.webContents.executeJavaScript(`(async()=>{
        const opened=await window.hearth.call('open-tab',{serviceKey:'browser',url:'about:blank'}).catch(e=>e);if(!(opened instanceof Error))throw Error('Browser tab accepted a non-web address');
        const tabs=await window.hearth.call('tabs');if(!tabs.browser || !tabs.browser.items.length)throw Error('Browser tabs missing');
        const second=await window.hearth.call('open-tab',{serviceKey:'browser'});if(second.tabs.items.length!==2 || second.tabs.active!==second.tabId)throw Error('New tab not active');
        const closed=await window.hearth.call('close-tab',{serviceKey:'browser',tabId:second.tabId});if(closed.items.length!==1)throw Error('Tab close failed');
        let bad=false;try{await window.hearth.call('place-views',[{serviceKey:'browser',tabId:'x',x:'a',y:0,width:1,height:1}]);}catch{bad=true;}if(!bad)throw Error('Invalid placement accepted');
        if((await window.hearth.call('place-views',[])).length!==0)throw Error('Empty placement failed');
        const group=await window.hearth.call('create-service-folder',{name:'Smoke group',icon:'🧪',keys:[]});if(group.folders.at(-1).icon!=='🧪')throw Error('Group icon lost');
        await window.hearth.call('update-service-folder',{id:group.folders.at(-1).id,name:'Renamed'});
        const removed=await window.hearth.call('remove-service-folder',group.folders.at(-1).id);if(removed.folders.length!==group.folders.length-1)throw Error('Group removal failed');
        const sleep=await window.hearth.call('set-sleep',{defaultMinutes:15});if(sleep.defaultMinutes!==15)throw Error('Sleep setting lost');
        let badSleep=false;try{await window.hearth.call('set-sleep',{defaultMinutes:7});}catch{badSleep=true;}if(!badSleep)throw Error('Invalid sleep delay accepted');
        await window.hearth.call('set-sleep',{defaultMinutes:0});
      })()`);
      const smokeTodos=addTask('  Smoke   task from a selection  ');if(smokeTodos.at(-1).text!=='Smoke task from a selection')throw Error('Task text not normalised');config.todos=[];
      config.services=[{id:'badge-smoke',name:'Unread badge test',url:'https://example.com'}];
      updateServiceBadge('badge-smoke',unreadCount('Inbox (23) - Gmail'));
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
      await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100 && !document.querySelector('[data-badge-key="badge-smoke"]');i++)await new Promise(r=>setTimeout(r,50));const badge=document.querySelector('[data-badge-key="badge-smoke"]');if(!badge || badge.hidden || badge.textContent!=='23' || getComputedStyle(badge).display==='none')throw Error('Sidebar unread badge missing');})()`);
      updateServiceBadge('badge-smoke',0);
      await win.webContents.executeJavaScript(`(async()=>{await new Promise(r=>setTimeout(r,100));if(!document.querySelector('[data-badge-key="badge-smoke"]').hidden)throw Error('Read badge not cleared');})()`);
      const connectedBefore=root;const nextFolder=path.join(root,'second-folder');await fs.mkdir(nextFolder,{recursive:true});config.connectedFolders=[connectedBefore,nextFolder];
      // Paths cross into page script as base64 so no path character can alter the script.
      const b64=value=>Buffer.from(String(value),'utf8').toString('base64');
      await win.webContents.executeJavaScript(`(async()=>{const decode=v=>new TextDecoder().decode(Uint8Array.from(atob(v),c=>c.charCodeAt(0)));const state=await window.hearth.call('select-files-folder',decode('${b64(nextFolder)}'));if(state.root!==state.claudeRoot || !state.connectedFolders.includes(decode('${b64(connectedBefore)}')))throw Error('Folder switch lost history or left Claude stale');})()`);
      const pdfTest=await require('pdf-lib').PDFDocument.create();pdfTest.addPage([200,200]);const {PDFName,PDFString}=require('pdf-lib');pdfTest.catalog.set(PDFName.of('OpenAction'),pdfTest.context.obj({S:'JavaScript',JS:PDFString.of('globalThis.__pdfAttack=1')}));
      const pdfBytes=Buffer.from(await pdfTest.save()).toString('base64');
      await win.webContents.executeJavaScript(`document.getElementById('documents-rail').click()`);
      await dc.executeJavaScript(`(async()=>{if(window.hearth || typeof require!=='undefined')throw Error('Document viewer has privileged app access');let denied=false;try{window.documents.call('start-terminal','shell');}catch{denied=true;}if(!denied)throw Error('Document bridge accepted terminal action');let networkBlocked=false;try{await fetch('https://example.com');}catch{networkBlocked=true;}if(!networkBlocked)throw Error('Document viewer network access enabled');const lib=await import('./node_modules/pdfjs-dist/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('./node_modules/pdfjs-dist/build/pdf.worker.mjs',location.href).href;const loading=lib.getDocument({data:Uint8Array.from(atob('${pdfBytes}'),c=>c.charCodeAt(0)),isEvalSupported:false});const pdf=await loading.promise;const page=await pdf.getPage(1);const canvas=document.getElementById('pdf-canvas');await page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale:1}),intent:'print'}).promise;await loading.destroy();if(globalThis.__pdfAttack)throw Error('PDF script executed');})()`);
      await require('./smoke-adversarial.cjs')({documentContents:dc});
      startTerminal('shell');
      await new Promise((resolve,reject) => {const timer=setTimeout(()=>reject(Error('PTY timed out')),5000); let output=''; terminal.onData(d=>{output+=d;if(output.includes('HEARTH_PTY_OK')){clearTimeout(timer);resolve();}}); terminal.write("printf 'HEARTH_%s_OK\\n' PTY\r");});
      terminal.kill();
      await fs.writeFile(path.join(__dirname,'smoke.png'),(await win.webContents.capturePage()).toPNG());
      console.log('SMOKE PASS: renderer, bridge, vault, path containment, tabs, groups, real PTY'); app.quit();
    } catch(e) {console.error(e);app.exit(1);}
  }
});
app.on('window-all-closed',() => app.quit());
