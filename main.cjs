const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme, net, nativeImage, safeStorage, systemPreferences, session, Notification, webContents, clipboard, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const crypto=require('node:crypto');
const pty = require('node-pty');
const {ChatSession} = require('./chat.cjs');
const {catalogue,findApp,isAdded,addApp,bundledIcon} = require('./app-catalog.cjs');
const {webPreferences,browserWebPreferences,browserPartition,BROWSER_PARTITION,configureWebContents,PROFILES,partitionFor} = require('./web-session.cjs');
const {reorder,createFolder,updateFolder,removeFolder,setFolder,cleanIcon}=require('./sidebar.cjs');
const {createFaviconCache}=require('./favicons.cjs');
const {startAutoUpdates}=require('./auto-update.cjs');
const {createSecureStore}=require('./secure-store.cjs');
const {createPasswordVault}=require('./passwords.cjs');
let passwords;const passwordOffers=new Map();
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
function lockApp(){if(!config.appLock || locked)return false;locked=true;hideAllViews();hidePopover();peekClose();for(const view of win.contentView.children)if(view.webContents?.getURL().endsWith('/document-view.html'))view.setVisible(false);send('app-locked',{locked:true,method:config.appLockMethod});return true;}
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
function stateSnapshot(){if(locked)return {locked:true,lockMethod:config.appLockMethod || 'touchID',theme:config.theme || 'light',version:app.getVersion()};return {locked:false,platform:process.platform,claudeSupported:CLAUDE_SUPPORTED,home:require('node:os').homedir(),root,claudeRoot,claudePolicy:config.claudePolicy || 'notes',claudeWorkspaces:config.claudeWorkspaces || (claudeRoot?[claudeRoot]:[]),connectedFolders:[...new Set([root,...(config.connectedFolders || []),...(config.claudeWorkspaces || [])].filter(Boolean))],services:config.services || [],serviceFolders:config.serviceFolders || [],sidebarOrder:config.sidebarOrder || [],serviceBadges:Object.fromEntries([...serviceBadges.keys()].map(key=>[key,visibleBadge(key)])),mutes:mutes(),zoom:config.zoom || {},peekLinks:config.peekLinks!==false,now:nowFeed(),presets:config.presets || [],recent:recentList(),tourDone:Boolean(config.tourDone),tabs:allTabs(),sleep:sleepSettings(),asleep:asleepKeys(),todos:config.todos || [],whiteboard:config.whiteboard || {items:[]},version:app.getVersion(),theme:config.theme || 'light',mode:config.mode || 'chat',layout:config.layout || {},chat:chat.snapshot()};}
function validWhiteboard(value){if(!value || !Array.isArray(value.items) || value.items.length>1000)throw Error('Invalid whiteboard');const camera=value.camera || {x:0,y:0,zoom:1};if(![camera.x,camera.y,camera.zoom].every(Number.isFinite) || camera.zoom<.2 || camera.zoom>3)throw Error('Invalid whiteboard view');const raw=JSON.stringify({items:value.items,camera:{x:camera.x,y:camera.y,zoom:camera.zoom}});if(raw.length>12_000_000)throw Error('Whiteboard is too large');const types=new Set(['path','note','text','rectangle','ellipse','arrow','image']);for(const item of value.items){if(!item || typeof item.id!=='string' || item.id.length>100 || !types.has(item.type))throw Error('Invalid whiteboard item');if(item.html!==undefined && (typeof item.html!=='string' || item.html.length>20000))throw Error('Note is too large');if(item.type==='image' && (typeof item.src!=='string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(item.src) || item.src.length>1_600_000))throw Error('Invalid whiteboard image');}return JSON.parse(raw);}
function validLayout(layout){
 const out={agentCollapsed:Boolean(layout.agentCollapsed),centreCollapsed:Boolean(layout.centreCollapsed),navCollapsed:Boolean(layout.navCollapsed),navColumns:layout.navColumns===2?2:1,navGrey:layout.navGrey!==false,chime:Boolean(layout.chime),navDock:layout.navDock!==false,page:['overview','browser-page','brain-page','security-page','files-page'].includes(layout.page)?layout.page:'overview'};
 const tiles=layout.tiles;
 if(tiles && typeof tiles==='object'){
  const mode=['1','2h','2v','3','4'].includes(tiles.mode)?tiles.mode:'1';
  const slots=Array.from({length:4},(_,i)=>{const slot=Array.isArray(tiles.slots)?tiles.slots[i]:null;if(slot && slot.kind==='document')return {kind:'document'};return slot && typeof slot.serviceKey==='string' && slot.serviceKey.length<200 && typeof slot.tabId==='string' && slot.tabId.length<100?{serviceKey:slot.serviceKey,tabId:slot.tabId}:null;});
  const ratio=Number(tiles.ratio);out.tiles={mode,slots,focus:Number.isInteger(tiles.focus) && tiles.focus>=0 && tiles.focus<4?tiles.focus:0,ratio:Number.isFinite(ratio)?Math.max(.2,Math.min(.8,ratio)):.5};
 }
 return out;
}
async function clearSessionData(target){await target.clearStorageData();await target.clearCache();await target.clearAuthCache();await target.cookies.flushStore();}
const hardenedSessions=new Set();
// Muted apps: no notifications and no unread count until the mute ends (-1 = forever). Counts are still tracked so they reappear on unmute.
function mutes(){const out={};const now=Date.now();for(const [key,until] of Object.entries(config.mutes || {}))if(until===-1 || until>now)out[key]=until;return out;}
function isMuted(key){const until=(config.mutes || {})[key];return until===-1 || (typeof until==='number' && until>Date.now());}
function visibleBadge(key){return isMuted(key)?0:(serviceBadges.get(key) || 0);}
function updateAppBadge(){let total=0;for(const key of serviceBadges.keys())total+=visibleBadge(key);app.setBadgeCount?.(Math.min(9999,total));}
let nowTimer=null;function nowSoon(){clearTimeout(nowTimer);nowTimer=setTimeout(()=>send('now-changed',nowFeed()),250);}
function updateServiceBadge(key,count){if(count)serviceBadges.set(key,count);else serviceBadges.delete(key);updateAppBadge();send('service-badge',{key,count:visibleBadge(key)});nowSoon();}
// Zoom is remembered per app and applied to every page of that app, whatever site it navigates to.
const ZOOM_STEPS=[0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2];
function zoomFor(key){const z=(config.zoom || {})[key];return ZOOM_STEPS.includes(z)?z:1;}
function applyZoom(serviceKey){const z=zoomFor(serviceKey);for(const entry of views.values())if(entry.serviceKey===serviceKey && !entry.view.webContents.isDestroyed())entry.view.webContents.setZoomFactor(z);}
// Recent: unread counts that rose while the app's pane was not on screen, so nothing has to be toured.
const recent=[];
function recentList(){return recent.slice(0,50);}
// Chat apps stay alive in the background so their notifications keep arriving; they never sleep and every tab is loaded at startup.
const CHAT_HOSTS=/(^|\.)(slack\.com|chat\.google\.com|teams\.microsoft\.com|teams\.live\.com|web\.whatsapp\.com|web\.telegram\.org|discord\.com|messenger\.com)$/i;
function isChatItem(item){try{return Boolean(item?.url) && CHAT_HOSTS.test(new URL(item.url).hostname);}catch{return false;}}
const NOTIFICATION_WRAPPER=`(()=>{try{const N=window.Notification;if(!N || N.__zen)return;const W=function(title,options){const n=new N(title,options);try{window.postMessage({__zen:'notification',title:String(title),body:String(options&&options.body||'')},'*');}catch{}return n;};W.prototype=N.prototype;W.__zen=true;W.requestPermission=(...a)=>N.requestPermission(...a);Object.defineProperty(W,'permission',{get:()=>N.permission});Object.defineProperty(W,'maxActions',{get:()=>N.maxActions});window.Notification=W;}catch{}})()`;
function pushRecent(entry){recent.unshift({id:crypto.randomUUID(),at:Date.now(),...entry});if(recent.length>50)recent.length=50;send('recent-changed',recentList());}
function expireMutes(){const now=Date.now();let changed=false;for(const [key,until] of Object.entries(config.mutes || {}))if(until!==-1 && until<=now){delete config.mutes[key];changed=true;updateServiceBadge(key,serviceBadges.get(key) || 0);}if(changed){persist();send('mutes-changed',mutes());}}
// Chromium forgets session cookies (those without an expiry) when the app quits, so logins that rely on them are lost
// between launches. Like other app-hosting shells, Just Zen gives such cookies a rolling 30-day expiry inside their own profile.
const KEEP_LOGIN_DAYS=30;
const flushTimers=new WeakMap();
function flushSoon(target){clearTimeout(flushTimers.get(target));flushTimers.set(target,setTimeout(()=>{target.cookies.flushStore().catch(()=>{});},1500));}
function keepSessionCookies(target){
  target.cookies.on('changed',(_event,cookie,_cause,removed)=>{
    flushSoon(target);
    if(removed || !cookie.session || !cookie.name)return;
    const host=cookie.domain?.replace(/^\./,'');if(!host)return;
    const details={url:(cookie.secure?'https://':'http://')+host+(cookie.path || '/'),name:cookie.name,value:cookie.value,path:cookie.path || '/',secure:Boolean(cookie.secure),httpOnly:Boolean(cookie.httpOnly),expirationDate:Math.floor(Date.now()/1000)+KEEP_LOGIN_DAYS*86400};
    if(!cookie.hostOnly && cookie.domain)details.domain=cookie.domain;
    if(cookie.sameSite && cookie.sameSite!=='unspecified')details.sameSite=cookie.sameSite;
    target.cookies.set(details).catch(()=>{});
  });
}
// Calls (Slack huddles, Google Meet) need the camera and microphone. A saved app asks once per site; the answer is remembered
// per app and site and can be forgotten from Privacy & data. macOS then asks for the app itself the first time.
async function mediaAllowed(source,contents,details){
  let origin='';try{origin=new URL(details?.requestingUrl || contents.getURL()).origin;}catch{return false;}
  if(!secureOrigin(origin))return false;
  let kinds=(details?.mediaTypes || []).filter(k=>k==='audio' || k==='video');if(!kinds.length)kinds=['audio','video'];
  config.mediaGrants=config.mediaGrants || {};const grantKey=source.key+' '+origin;
  if(config.mediaGrants[grantKey]===true)return systemMedia(kinds);
  if(config.mediaGrants[grantKey]===false)return false;
  const what=kinds.includes('video') && kinds.includes('audio')?'camera and microphone':kinds.includes('video')?'camera':'microphone';
  const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Allow','Don\u2019t allow'],defaultId:0,cancelId:1,message:source.name+' wants to use your '+what,detail:origin+'\n\nNeeded for calls and huddles. Just Zen remembers this choice for '+source.name+'; change it later in Privacy & data.'});
  config.mediaGrants[grantKey]=response===0;await persist();
  return response===0?systemMedia(kinds):false;
}
async function systemMedia(kinds){for(const kind of kinds){const type=kind==='video'?'camera':'microphone';try{const status=systemPreferences.getMediaAccessStatus?.(type);if(status==='granted')continue;if(status==='denied' || status==='restricted'){const {response}=await dialog.showMessageBox(win,{type:'warning',buttons:['Open System Settings','Cancel'],defaultId:0,cancelId:1,message:'macOS is blocking the '+type+' for Just Zen',detail:'Turn on Just Zen under Privacy & Security › '+(type==='camera'?'Camera':'Microphone')+', then try the call again.'});if(response===0)shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_'+(type==='camera'?'Camera':'Microphone')).catch(()=>{});return false;}const ok=await systemPreferences.askForMediaAccess?.(type);if(ok===false)return false;}catch{}}return true;}
function hardenWebSession(target){
  if(hardenedSessions.has(target))return;
  hardenedSessions.add(target);
  keepSessionCookies(target);
  const allowedOrigins=notificationOrigins.get(target) || new Set();notificationOrigins.set(target,allowedOrigins);
  target.setPermissionRequestHandler(async (contents,permission,callback,details)=>{
    const source=notificationSources.get(contents),origin=details?.requestingUrl || details?.securityOrigin || '';
    if(permission==='media' && source){callback(await mediaAllowed(source,contents,details));return;}
    const allowed=permission==='notifications' && canNotify(source,contents,origin);
    if(allowed){source.notificationPermission=true;try{allowedOrigins.add(new URL(origin || contents.getURL()).origin);}catch{}}
    callback(allowed);
  });
  target.setPermissionCheckHandler((contents,permission,requestingOrigin)=>{
    // Microphone and camera: a remembered refusal is final; anything else is left to the request handler, which asks.
    if(permission==='media'){const source=contents?notificationSources.get(contents):null;if(!source || !secureOrigin(requestingOrigin))return false;try{return config.mediaGrants?.[source.key+' '+new URL(requestingOrigin).origin]!==false;}catch{return false;}}
    if(permission!=='notifications' || !secureOrigin(requestingOrigin))return false;
    if(contents){const source=notificationSources.get(contents);if(source?.key && isMuted(source.key))return false;return canNotify(source,contents,requestingOrigin);}
    try{return allowedOrigins.has(new URL(requestingOrigin).origin);}catch{return false;}
  });
  target.setDisplayMediaRequestHandler?.((_request,callback)=>callback({}));
  // Downloads use Electron's own save dialog, configured synchronously here; a second, asynchronous dialog used to race it and
  // could leave the download cancelled. On completion a toast offers to reveal the file.
  target.on('will-download',(_event,item)=>{
    const suggested=item.getFilename().replace(/[\\/\0]/g,'_').slice(0,240) || 'download';
    item.setSaveDialogOptions({title:'Save download from Just Zen',defaultPath:path.join(app.getPath('downloads'),suggested),buttonLabel:'Save'});
    item.once('done',(_e,state)=>{const saved=item.getSavePath();if(state==='completed' && saved)send('download-done',{name:path.basename(saved),path:saved});else if(state==='interrupted')send('notice','Download of '+suggested+' was interrupted.');});
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
function cleanEmoji(icon){const value=cleanIcon(icon);return value==='◫'?'🌐':value;}
function cleanTabs(serviceKey,raw){
 const item=serviceItem(serviceKey);if(!item)return null;
 const items=(Array.isArray(raw?.items)?raw.items:[]).filter(t=>t && typeof t.id==='string' && t.id.length<100).slice(0,20).map(t=>({id:t.id,url:typeof t.url==='string' && t.url?t.url:'',current:typeof t.current==='string' && t.current?t.current:'',title:typeof t.title==='string'?t.title.slice(0,200):'',...(t.scroll && Number.isFinite(t.scroll.x) && Number.isFinite(t.scroll.y)?{scroll:{x:t.scroll.x,y:t.scroll.y},scrollURL:typeof t.scrollURL==='string'?t.scrollURL:''}:{})}));
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
function destroyView(key){const entry=views.get(key);if(!entry)return;views.delete(key);try{win.contentView.removeChildView(entry.view);}catch{}try{entry.view.webContents.close({waitForBeforeUnload:false});}catch{try{entry.view.webContents.close();}catch{}}}
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
// Peek: a link opened from an app slides out in a drawer over the right of the centre instead of taking the whole pane.
// Esc dismisses it; it can be promoted to a tab, or opened beside. Popups and Shift+Space on a hovered link both land here.
let peek=null,peekStack=[];
const AUTH_HOSTS=/(^|\.)(accounts\.google\.com|accounts\.youtube\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|id\.atlassian\.com|login\.yahoo\.com|okta\.com|auth0\.com|login\.salesforce\.com|auth\.atlassian\.com|signin\.aws\.amazon\.com)$/i;
// A popup from the drawer (Sign in with Google) keeps its opener alive underneath: OAuth talks back to it, then window.close() brings it back.
function peekOpen(serviceKey,options,url,from=null){
  if(from && peek && peek.view.webContents===from){peek.view.setVisible(false);peek.visible=false;peekStack.push(peek);peek=null;}else peekClose();
  const item=serviceItem(serviceKey);if(!item)return null;
  const view=new WebContentsView({...(options || {}),webPreferences:{...(options?.webPreferences || {}),...preferencesFor(serviceKey)}});
  win.contentView.addChildView(view);view.setVisible(false);
  const contents=view.webContents;
  peek={view,serviceKey,visible:false,name:item.name,announce:null,opener:from && !from.isDestroyed()?from:null,auth:null};
  notificationSources.set(contents,{contents,saved:false,key:serviceKey,name:item.name+' (peek)',notificationPermission:false,badgeInitialized:false,origins:new Set(),landed:false});
  hardenWebSession(contents.session);
  configureWebContents(contents,win,message=>send('notice',message),contents,preferencesFor(serviceKey),o=>peekOpen(serviceKey,o,'',contents));
  attachContextMenu(contents,()=>item.name);
  const announce=()=>{if(!contents.isDestroyed() && peek?.view===view)send('peek-update',{url:contents.getURL(),title:contents.getTitle(),loading:contents.isLoading(),canGoBack:contents.navigationHistory.canGoBack()});};
  peek.announce=announce;for(const event of ['did-navigate','did-navigate-in-page','did-start-loading','did-stop-loading','page-title-updated'])contents.on(event,announce);
  contents.on('did-finish-load',()=>{contents.__darkKey=null;darkenIfLight(contents);});
  // A sign-in popup that ends by landing on the app instead of closing itself: bring the result back to the pane that asked for it.
  const hostOfURL=u=>{try{return new URL(u).hostname;}catch{return '';}};
  const sawAuth=(_e,url)=>{if(peek?.view===view && AUTH_HOSTS.test(hostOfURL(url)))peek.auth=true;};
  contents.on('did-redirect-navigation',sawAuth);contents.on('did-start-navigation',sawAuth);
  contents.on('did-navigate',(_e,url)=>{if(!peek || peek.view!==view || !/^https?:/i.test(url))return;const host=hostOfURL(url);if(AUTH_HOSTS.test(host)){peek.auth=true;return;}const opener=peek.opener;if(!opener || opener.isDestroyed())return;const openerHost=hostOfURL(opener.getURL());const callback=host===openerHost && /(auth|oauth|callback|login|signin|sso|session)/i.test(new URL(url).pathname);if(!peek.auth && !callback)return;peek.auth=false;setTimeout(()=>{try{if(host===openerHost)opener.loadURL(url);else opener.reload();}catch{}peekClose();},120);});
  contents.once('destroyed',()=>{if(peek?.view===view){peek=null;peekRestore();}else{const i=peekStack.indexOf(peekStack.find(p=>p.view===view));if(i>=0)peekStack.splice(i,1);}});
  if(url)contents.loadURL(url).catch(()=>{});
  send('peek-opened',{serviceKey,name:item.name});
  return contents;
}
let appPeek=null;
function peekRestore(){const parent=peekStack.pop();if(!parent || parent.view.webContents.isDestroyed()){if(parent)peekRestore();else send('peek-closed');return;}peek=parent;send('peek-opened',{serviceKey:parent.serviceKey,name:parent.name});parent.announce?.();}
function peekClose(){if(appPeek){appPeek=null;send('peek-closed');}for(const p of peekStack.splice(0)){try{win.contentView.removeChildView(p.view);}catch{}try{p.view.webContents.close();}catch{}}if(!peek)return;const {view}=peek;peek=null;try{win.contentView.removeChildView(view);}catch{}try{view.webContents.close();}catch{}send('peek-closed');}
function peekPlace(box){if(appPeek){if(box?.visible){win.contentView.addChildView(appPeek.view);appPeek.view.setBounds(clipBounds(box));appPeek.view.setVisible(!locked);appPeek.visible=true;appPeek.hiddenSince=0;}return;}if(!peek)return;if(!box?.visible){peek.view.setVisible(false);peek.visible=false;return;}win.contentView.addChildView(peek.view);peek.view.setBounds(clipBounds(box));peek.view.setVisible(!locked);peek.visible=true;}
function popupAsTab(serviceKey,options,opener=null){
  // Only a popup from an app the user is looking at gets the drawer; background apps (sign-in bounces, warm-up) get a quiet tab.
  const openerEntry=opener?[...views.values()].find(v=>v.view.webContents===opener):null;
  if(config.peekLinks!==false && (!opener || openerEntry?.visible || (peek && peek.view.webContents===opener) || (appPeek && appPeek.view.webContents===opener)))return peekOpen(serviceKey,options,'',opener);
  const tabs=tabsFor(serviceKey);if(tabs.items.length>=20)return null;
  const tab={id:crypto.randomUUID(),url:'',current:'',title:''};tabs.items.push(tab);tabs.active=tab.id;persist();
  const view=new WebContentsView({...options,webPreferences:{...(options.webPreferences || {}),...preferencesFor(serviceKey)}});
  const entry=attachView(serviceKey,tab.id,view,'');
  entry.view.webContents.once('destroyed',()=>{views.delete(viewKey(serviceKey,tab.id));const live=tabsFor(serviceKey);const index=live.items.findIndex(t=>t.id===tab.id);if(index<0)return;live.items.splice(index,1);if(!live.items.length)live.items.push({id:crypto.randomUUID(),url:isBrowserItem(serviceItem(serviceKey))?'':serviceItem(serviceKey)?.url || '',current:'',title:''});if(live.active===tab.id)live.active=live.items[Math.max(0,index-1)].id;persist();send('tabs-changed',{serviceKey,tabs:live});});
  if(!opener || openerEntry?.visible)send('tab-opened',{serviceKey,tabId:tab.id,tabs});else send('tabs-changed',{serviceKey,tabs});
  return view.webContents;
}
function attachView(serviceKey,tabId,view,url){
  const item=serviceItem(serviceKey);if(!item)throw Error('App not found');
  const key=viewKey(serviceKey,tabId);
  const isBrowser=isBrowserItem(item);
  const preferences=preferencesFor(serviceKey);
  const entry={view,serviceKey,tabId,visible:false,hiddenSince:Date.now(),mobile:false,desktopUA:view.webContents.getUserAgent()};
  views.set(key,entry);win.contentView.addChildView(view);view.setVisible(false);
  const contents=view.webContents;
  contents.once('destroyed',()=>{if(views.get(key)===entry){views.delete(key);try{win.contentView.removeChildView(view);}catch{}}});
  contents.on('focus',()=>send('tab-focused',{serviceKey,tabId}));
  const notificationSource={contents,saved:!isBrowser,key:serviceKey,name:item.name,notificationPermission:false,badgeInitialized:false,origins:new Set(),landed:false};
  notificationSources.set(contents,notificationSource);
  hardenWebSession(contents.session);
  const origins=notificationOrigins.get(contents.session);try{if(!isBrowser && secureOrigin(url)){origins.add(new URL(url).origin);notificationSource.origins.add(new URL(url).origin);}}catch{}
  configureWebContents(contents,win,message=>send('notice',message),contents,preferences,options=>popupAsTab(serviceKey,options,contents) || undefined);
  attachContextMenu(contents,()=>item.name,params=>params.linkURL && /^https?:/i.test(params.linkURL)?[{label:'Open Link in Quick Look',click:()=>peekOpen(serviceKey,null,params.linkURL)},{label:'Open Link in New Tab',click:()=>openTab(serviceKey,params.linkURL,true)}]:[]);
  contents.on('page-favicon-updated',async (_e,urls)=>{if(!urls.length || isBrowser || bundledIcon(item))return;const icon=await favicon(item.url,urls[0]);if(icon)send('favicon',{url:item.url,icon});});
  // Origins reached by the app's initial redirect chain may notify; later navigations (open redirects, links) may not.
  // Signed-out visits to chat/calendar/mail.google.com bounce to Google's marketing site; send those to the sign-in page that continues to the app instead.
  contents.on('did-navigate',(_e,target)=>{try{if(!isBrowser){const home=new URL(item.url).hostname,landed=new URL(target).hostname;if(/^(chat|calendar|mail|meet|drive|docs|keep)\.google\.com$/.test(home) && /(^|\.)workspace\.google\.com$/.test(landed) && !contents.__bounced){contents.__bounced=true;contents.loadURL('https://accounts.google.com/ServiceLogin?continue='+encodeURIComponent(item.url));return;}}}catch{}
   try{if(!isBrowser && !notificationSource.landed && secureOrigin(target)){origins.add(new URL(target).origin);notificationSource.origins.add(new URL(target).origin);}}catch{}try{const live=tabOf(serviceKey,tabId);live.current=target;if(isBrowser && !live.url)live.url=target;persistSoon();}catch{}announceTab(entry);contents.session.cookies.flushStore().catch(()=>{});});
  contents.on('did-navigate-in-page',(_e,_target,isMainFrame)=>{if(isMainFrame)announceTab(entry);});
  // Chromium keeps zoom per site; Just Zen keeps it per app, so it is reapplied after every navigation.
  for(const event of ['dom-ready','did-navigate'])contents.on(event,()=>{if(!contents.isDestroyed())contents.setZoomFactor(zoomFor(serviceKey));});
  for(const event of ['did-start-loading','did-stop-loading'])contents.on(event,()=>announceTab(entry));
  contents.once('did-finish-load',()=>{notificationSource.landed=true;});
  // Scroll position is remembered per tab and restored on the next launch, once the page is on the same address.
  contents.on('did-finish-load',()=>{contents.__darkKey=null;darkenIfLight(contents);});
  contents.on('did-navigate-in-page',(_e,_u,isMain)=>{if(isMain)setTimeout(()=>darkenIfLight(contents),300);});
  contents.on('did-finish-load',()=>{try{const live=tabOf(serviceKey,tabId);if(live.scroll && live.scrollURL===contents.getURL() && (live.scroll.x || live.scroll.y))contents.executeJavaScript('window.scrollTo('+Number(live.scroll.x)+','+Number(live.scroll.y)+')',true).catch(()=>{});}catch{}});
  entry.scrollTimer=setInterval(()=>{if(contents.isDestroyed() || !entry.visible)return;contents.executeJavaScript('[window.scrollX|0,window.scrollY|0]',true).then(([x,y])=>{try{const live=tabOf(serviceKey,tabId);if(live.scroll?.x===x && live.scroll?.y===y)return;live.scroll={x,y};live.scrollURL=contents.getURL();persistSoon();}catch{}}).catch(()=>{});},3000);
  contents.once('destroyed',()=>clearInterval(entry.scrollTimer));
  contents.on('did-fail-load',(_e,code,description)=>{if(code!==-3)send('notice','Page could not load: '+description);});
  contents.on('will-prevent-unload',e=>e.preventDefault());
  if(!isBrowser)contents.on('dom-ready',()=>{contents.executeJavaScript(NOTIFICATION_WRAPPER,true).catch(()=>{});});
  contents.on('page-title-updated',(_event,title)=>{
    try{const live=tabOf(serviceKey,tabId);live.title=String(title).slice(0,200);persistSoon();}catch{}
    announceTab(entry);
    if(isBrowser)return;
    const count=Math.max(unreadCount(title),notificationSource.domUnread || 0),previous=serviceBadges.get(serviceKey) || 0;
    updateServiceBadge(serviceKey,count);
    if(notificationSource.badgeInitialized && count>previous && !entry.visible && !isMuted(serviceKey))pushRecent({key:serviceKey,name:item.name,added:count-previous,count});
    if(notificationSource.badgeInitialized && count>previous && !notificationSource.notificationPermission && !isMuted(serviceKey) && Notification.isSupported()){
      const alert=new Notification({title:item.name,body:count===1?'1 unread message':count+' unread messages',silent:false});
      alert.on('click',()=>{win.show();win.focus();send('open-service',serviceKey);});alert.show();
    }
    notificationSource.badgeInitialized=true;
  });
  send('service-asleep',{key:serviceKey,asleep:false});
  return entry;
}

function clipBounds(box){const [w,h]=win.getContentSize();const x=Math.max(0,Math.min(w,Math.round(box.x))),y=Math.max(0,Math.min(h,Math.round(box.y)));return {x,y,width:Math.max(0,Math.min(w-x,Math.round(box.width))),height:Math.max(0,Math.min(h-y,Math.round(box.height)))};}
// ---- Pane search badges: a floating ⌕ over the top-right of each pane ----
const badges=[];
function ensureBadge(i){if(badges[i] && !badges[i].view.webContents.isDestroyed())return badges[i];
  const view=new WebContentsView({webPreferences:{preload:path.join(__dirname,'pane-badge-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,partition:'popover',backgroundThrottling:false}});
  const c=view.webContents;c.session.setPermissionRequestHandler((_c,_p,done)=>done(false));c.session.setPermissionCheckHandler(()=>false);
  const allowed=new Set(['pane-badge.html','pane-badge.js'].map(f=>pathToFileURL(path.join(__dirname,f)).href));
  c.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowed.has(details.url)}));
  c.setWindowOpenHandler(()=>({action:'deny'}));c.on('will-navigate',e=>e.preventDefault());
  try{view.setBackgroundColor('#00000000');}catch{}
  c.on('did-finish-load',()=>{c.send('badge-theme',config.theme || 'light');c.send('badge-labelled',badgeLabelled());});c.loadFile('pane-badge.html');
  const entry={view,attached:false,visible:false};badges[i]=entry;return entry;}
function badgeLabelled(){return (config.searchUses || 0)<4;}
function placeBadges(list){const wanted=new Map();for(const p of list)if(Number.isInteger(p.slot) && p.slot>=0 && p.slot<4)wanted.set(p.slot,p);
  for(let i=0;i<4;i++){const p=wanted.get(i);if(!p){if(badges[i]?.visible){badges[i].view.setVisible(false);badges[i].visible=false;}continue;}
    const b=ensureBadge(i);const wide=badgeLabelled()?184:86;const box=clipBounds({x:p.x+p.width-wide-6,y:p.y+6,width:wide,height:44});
    if(!b.attached || !b.visible){win.contentView.addChildView(b.view);b.attached=true;}
    b.view.setBounds(box);if(!b.visible){b.view.setVisible(!locked);b.visible=true;}}}
function retintBadges(){for(const b of badges)if(b && !b.view.webContents.isDestroyed())b.view.webContents.send('badge-theme',config.theme || 'light');}
// An app can opt into the mobile web when its pane is thin (phone user agent and viewport); by default a narrow pane is just the site in a smaller window.
const MOBILE_WIDTH=480;
const MOBILE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
function applyFormFactor(entry){const c=entry.view.webContents;if(c.isDestroyed())return;try{if(entry.mobile){c.setUserAgent(MOBILE_UA);const b=entry.view.getBounds();c.enableDeviceEmulation({screenPosition:'mobile',screenSize:{width:b.width,height:b.height},viewPosition:{x:0,y:0},deviceScaleFactor:0,viewSize:{width:0,height:0},scale:1});}else{c.setUserAgent(entry.desktopUA);c.disableDeviceEmulation();}}catch{}if(/^https?:/i.test(c.getURL()))c.reload();}
function placeViews(list){
  if(!Array.isArray(list) || list.length>4)throw Error('Invalid placement');
  const wanted=new Map();
  for(const p of list){
    if(p && p.document===true && ['x','y','width','height'].every(k=>Number.isFinite(p[k])))continue;
    if(!p || typeof p.serviceKey!=='string' || typeof p.tabId!=='string' || !['x','y','width','height'].every(k=>Number.isFinite(p[k])))throw Error('Invalid placement');
    let entry=null;try{entry=ensureView(p.serviceKey,p.tabId);}catch{}
    if(entry)wanted.set(viewKey(p.serviceKey,p.tabId),{...clipBounds(p),radius:Number.isFinite(p.radius)?Math.max(0,Math.min(24,Math.round(p.radius))):0});
  }
  if(locked){placeBadges([]);return [];}
  for(const [key,entry] of views){
    if(appPeek && entry===appPeek)continue;
    const box=wanted.get(key);
    if(box){entry.view.setBounds({x:box.x,y:box.y,width:box.width,height:box.height});const mobile=box.width<MOBILE_WIDTH && serviceItem(entry.serviceKey)?.mobile===true;if(entry.mobile!==mobile){entry.mobile=mobile;clearTimeout(entry.formTimer);entry.formTimer=setTimeout(()=>applyFormFactor(entry),400);}if(typeof entry.view.setBorderRadius==='function' && entry.radius!==box.radius){entry.radius=box.radius;try{entry.view.setBorderRadius(box.radius);}catch{}}if(!entry.visible){entry.view.setVisible(true);entry.visible=true;entry.hiddenSince=0;}}
    else if(entry.visible){entry.view.setVisible(false);entry.visible=false;entry.hiddenSince=Date.now();}
  }
  placeBadges(list.filter(p=>p.document===true || wanted.has(viewKey(p.serviceKey,p.tabId))));
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
    const item=serviceItem(entry.serviceKey);const explicit=entry.serviceKey in sleepSettings().apps;
    if(isBrowserItem(item) || (isChatItem(item) && !explicit) || !minutes || entry.visible || !entry.hiddenSince || now-entry.hiddenSince<minutes*60_000)continue;
    const contents=entry.view.webContents;
    if(contents.isDestroyed()){views.delete(key);continue;}
    if(contents.isCurrentlyAudible())continue;
    destroyView(key);
    if(![...views.values()].some(v=>v.serviceKey===entry.serviceKey))send('service-asleep',{key:entry.serviceKey,asleep:true});
  }
}
// Where something came from, so a task or a chat message can take you back: a tab (app + tab + address), a note, or the document pane.
function cleanFrom(from){if(!from || typeof from!=='object')return null;const s=(v,n)=>typeof v==='string'?v.slice(0,n):'';if(from.kind==='tab' && s(from.key,200))return {kind:'tab',key:s(from.key,200),tabId:s(from.tabId,100),url:/^https?:/i.test(s(from.url,2000))?s(from.url,2000):'',name:s(from.name,60)};if(from.kind==='note' && s(from.path,1000))return {kind:'note',path:s(from.path,1000)};if(from.kind==='document')return {kind:'document'};return null;}
function fromContents(contents){const entry=[...views.values()].find(v=>v.view.webContents===contents);if(entry)return {kind:'tab',key:entry.serviceKey,tabId:entry.tabId,url:contents.getURL(),name:serviceItem(entry.serviceKey)?.name || ''};if(peek && peek.view.webContents===contents)return {kind:'tab',key:peek.serviceKey,tabId:'',url:contents.getURL(),name:serviceItem(peek.serviceKey)?.name || ''};return null;}
function addTask(text,from=null){
  const clean=String(text || '').replace(/\s+/g,' ').trim().slice(0,300);if(!clean)throw Error('Enter a task');
  config.todos=config.todos || [];const todo={id:crypto.randomUUID(),text:clean,done:false,createdAt:Date.now()};const src=cleanFrom(from);if(src)todo.from=src;config.todos.push(todo);persist();
  return config.todos;
}
function taskFromSelection(text,from=null){try{const todos=addTask(text,from);send('todos-changed',todos);send('notice','Added to your tasks: '+todos.at(-1).text.slice(0,80));}catch(error){send('notice',error.message);}}
// Right-click menu for any pane: send the selection to the Claude context card or straight to Tasks, plus the usual editing items.
function attachContextMenu(contents,sourceName,extra=()=>[]){
  contents.on('context-menu',(_event,params)=>{
    if(locked)return;
    if(Date.now()-(contents.__preloadMenuAt || 0)<600)return;
    const text=String(params.selectionText || '').trim(),items=[];
    if(text)items.push({label:'Send Selection to Claude',click:()=>send('claude-context',{text:text.slice(0,20000),source:sourceName(),from:fromContents(contents)})},{label:'Send Selection to Tasks',click:()=>taskFromSelection(text,fromContents(contents))});
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
  const allowed=new Set(['popover.html','popover.css','popover.js','assets/icons/material-symbols.js'].map(f=>pathToFileURL(path.join(__dirname,f)).href));
  pc.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowed.has(details.url)}));
  pc.setWindowOpenHandler(()=>({action:'deny'}));pc.on('will-navigate',e=>e.preventDefault());
  popover.on('blur',()=>hidePopover());
  popover.on('closed',()=>{popover=null;});
  pc.loadFile('popover.html');
  return popover;
}
function popoverTrusted(e){if(!popover || popover.isDestroyed() || e.sender!==popover.webContents)throw Error('Untrusted popover request');}
function hidePopover(){popoverFolder=null;if(popover && !popover.isDestroyed() && popover.isVisible())popover.hide();}
async function showPopover({folderId,left,top,above}){
  const folder=(config.serviceFolders || []).find(f=>f.id===folderId);if(!folder)throw Error('Group not found');
  const members=(config.services || []).filter(s=>openable(s) && s.folderId===folderId);
  const items=await Promise.all(members.map(async item=>({key:item.id || item.url,name:item.name,icon:isBrowserItem(item)?null:await iconFor(item),emoji:isBrowserItem(item)?item.icon || '🌐':null,badge:visibleBadge(item.id || item.url)})));
  const window_=ensurePopover();popoverFolder=folderId;
  if(window_.webContents.isLoading())await new Promise(resolve=>window_.webContents.once('did-finish-load',resolve));
  const cb=win.getContentBounds();
  window_.__anchor={x:cb.x+Math.round(left),y:cb.y+Math.round(top),above:Boolean(above)};
  window_.webContents.send('popover-show',{folder,items,theme:config.theme || 'light'});
  return true;
}
function placePopover(size){
  if(!popover || popover.isDestroyed() || !popoverFolder)return;
  const {x,y}=popover.__anchor || {x:0,y:0};const {x:wx,y:wy,width:ww,height:wh}=win.getContentBounds();
  const width=Math.max(160,Math.min(620,Math.round(size.width))),height=Math.max(80,Math.min(wh,Math.round(size.height)));
  const top=popover.__anchor?.above?y-height:y-10;
  popover.setBounds({x:Math.max(wx,Math.min(x,wx+ww-width)),y:Math.max(wy,Math.min(top,wy+wh-height)),width,height});
  if(!popover.isVisible())popover.show();else popover.focus();
}
function webViewOrigin(e){const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry)throw Error('Untrusted request');const url=e.senderFrame?.url || '';return passwords.originOf(url)?url:null;}
// Dark mode for websites: when the app is dark, pages that stay light are inverted (images and video inverted back). Nothing is touched in light mode.
const DARK_CSS='html{filter:invert(1) hue-rotate(180deg)!important;background:#111!important}img,video,canvas,picture,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}';
async function darkenIfLight(contents){
  if(contents.isDestroyed())return;
  const key=contents.__darkKey;
  if((config.theme || 'light')!=='dark'){if(key){contents.removeInsertedCSS(key).catch(()=>{});contents.__darkKey=null;}return;}
  let light=false;try{light=await contents.executeJavaScript("(()=>{const rgb=s=>{const m=s.match(/\\d+(\\.\\d+)?/g);if(!m||m.length<3)return null;const a=m[3]===undefined?1:Number(m[3]);if(a<.2)return null;return m.slice(0,3).map(Number);};const lum=c=>c?(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255:null;const body=rgb(getComputedStyle(document.body||document.documentElement).backgroundColor),html=rgb(getComputedStyle(document.documentElement).backgroundColor);const l=lum(body)??lum(html)??1;return l>0.55;})()",true);}catch{return;}
  if(light && !key){contents.__darkKey=await contents.insertCSS(DARK_CSS).catch(()=>null);}
  else if(!light && key){await contents.removeInsertedCSS(key).catch(()=>{});contents.__darkKey=null;}
}
// The Now stream: per app, its unread count and the named items its page reported, newest first.
function nowFeed(){const out=[];for(const item of (config.services || []).filter(openable)){const key=item.id || item.url;const entry=[...views.values()].find(v=>v.serviceKey===key);const source=entry?notificationSources.get(entry.view.webContents):null;const count=visibleBadge(key);const items=source?.items || [];if(!count && !items.length)continue;out.push({key,name:item.name,count,items,at:source?.itemsAt || 0,muted:isMuted(key)});}return out.sort((a,b)=>(b.count-a.count) || (b.at-a.at));}
function retheme(){for(const entry of views.values())darkenIfLight(entry.view.webContents);retintBadges();}
function subscriptionEnv(){
  const env={...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',PATH:'/opt/homebrew/bin:/usr/local/bin:'+process.env.PATH,CLAUDE_CONFIG_DIR:claudeConfigDir};
  delete env.ELECTRON_RUN_AS_NODE;
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[key];
  return env;
}
// Claude runs inside an operating-system sandbox, which this app only provides on macOS. Elsewhere it stays off rather than run unsandboxed.
const CLAUDE_SUPPORTED=process.platform==='darwin';
const CLAUDE_UNAVAILABLE='Claude is not available on Windows yet: it runs inside a macOS sandbox, and Just Zen will not run it without one.';
function startTerminal(kind = 'claude') {
  if(!CLAUDE_SUPPORTED && kind!=='shell')throw Error(CLAUDE_UNAVAILABLE);
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
  passwords=createPasswordVault({fs,safeStorage,userData:app.getPath('userData')});
  try { config = await secureStore.load(); if(config.root) root = await fs.realpath(config.root);if(config.claudeRoot)claudeRoot=await fs.realpath(config.claudeRoot);else if(root){claudeRoot=root;config.claudeRoot=root;}if(claudeRoot)config.claudeWorkspaces=[claudeRoot,...(config.claudeWorkspaces || []).filter(value=>value!==claudeRoot)].slice(0,12); } catch(error){console.error(error);config={};}
  if(!(config.services || []).some(isBrowserItem)){config.services=[{id:BROWSER_KEY,kind:'browser',name:'Browser',icon:'🌐',profile:'isolated'},...(config.services || [])];if(Array.isArray(config.sidebarOrder) && config.sidebarOrder.length)config.sidebarOrder=[BROWSER_KEY,...config.sidebarOrder.filter(e=>e!==BROWSER_KEY)];await persist();}
  const unprofiled=(config.services || []).some(item=>item.url && !item.profile);if(unprofiled){config.services=config.services.map(item=>item.url && !item.profile?{...item,profile:'isolated'}:item);await persist();}
  if(!config.whiteboard && Array.isArray(config.stickyNotes)){config.whiteboard={items:config.stickyNotes.map((note,index)=>({id:note.id || crypto.randomUUID(),type:'note',x:80+(index%4)*245,y:90+Math.floor(index/4)*195,w:220,h:170,text:String(note.text || ''),color:{sun:'#fff0a8',blue:'#dcecff',mint:'#dff2df',rose:'#f7dfe5'}[note.color] || '#fff0a8',rotation:(index%2?1:-1)*.6}))};delete config.stickyNotes;await persist();}
  locked=Boolean(config.appLock);
  favicon=createFaviconCache(path.join(app.getPath('userData'),'favicons'),net,createImageDecoder({BrowserWindow}));
  nativeTheme.themeSource=config.theme || 'light';
  chat=new ChatSession({claudePath:findClaude(),emit:state=>send('chat-state',state),policy:()=>({mode:config.claudePolicy || 'notes',root:claudeRoot}),env:()=>({...subscriptionEnv(),ANTHROPIC_API_KEY:undefined,ANTHROPIC_AUTH_TOKEN:undefined,ANTHROPIC_BASE_URL:undefined,CLAUDE_CODE_USE_BEDROCK:undefined,CLAUDE_CODE_USE_VERTEX:undefined,CLAUDE_CODE_USE_FOUNDRY:undefined}),save:async state=>{if(!claudeRoot)return;config.chats=config.chats || {};config.chats[claudeRoot]=state;await persist();}});
  chat.restore(config.chats?.[claudeRoot]);
  win = new BrowserWindow({show:false,width:1440,height:940,minWidth:1100,minHeight:700,title:'Just Zen',icon:path.join(__dirname,'assets','justzen.png'),titleBarStyle:process.platform==='darwin'?'hiddenInset':'hidden',...(process.platform==='win32'?{titleBarOverlay:{color:'#ffffff',symbolColor:'#354258',height:44}}:{}),backgroundColor:'#ffffff',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  // Send the current selection, wherever the focus is, to the Claude context card or to Tasks. Nothing is sent to Claude until the user picks an action.
  async function sendSelectionTo(target){
    if(locked)return;
    const focused=webContents.getFocusedWebContents();
    if(!focused || focused===win.webContents){send('capture-selection',{target});return;}
    if(focused===dc){dc.send('capture-selection',target);return;}
    for(const entry of views.values())if(entry.view.webContents===focused){
      let text='';try{text=String(await focused.executeJavaScript('String(window.getSelection ? window.getSelection().toString() : "")',true)).slice(0,20000);}catch{}
      if(!text.trim()){send('notice','Select some text first, then press '+(target==='task'?'⌘⇧T.':'⌘⇧A.'));return;}
      if(target==='task')taskFromSelection(text,fromContents(focused));else send('claude-context',{text,source:notificationSources.get(focused)?.name || 'the web app',from:fromContents(focused)});return;
    }
    send('capture-selection',{target});
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Just Zen',submenu:[{role:'about'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'Go',submenu:[{label:'Command Palette',accelerator:'CmdOrCtrl+Shift+P',click:()=>{if(!locked)send('open-palette',true);}},{label:'Send Selection to Claude',accelerator:'CmdOrCtrl+Shift+A',click:()=>sendSelectionTo('claude')},{label:'Send Selection to Tasks',accelerator:'CmdOrCtrl+Shift+T',click:()=>sendSelectionTo('task')},{type:'separator'},{label:'New Tab',accelerator:'CmdOrCtrl+T',click:()=>{if(!locked)send('tab-command','new');}},{label:'Close Tab',accelerator:'CmdOrCtrl+W',click:()=>{if(!locked)send('tab-command','close');}},{label:'Reload Tab',accelerator:'CmdOrCtrl+R',click:()=>{if(!locked)send('tab-command','reload');}},{label:'Address Bar',accelerator:'CmdOrCtrl+L',click:()=>{if(!locked)send('tab-command','address');}},{type:'separator'},{label:'Zoom In',accelerator:'CmdOrCtrl+=',click:()=>{if(!locked)send('tab-command','zoom-in');}},{label:'Zoom Out',accelerator:'CmdOrCtrl+-',click:()=>{if(!locked)send('tab-command','zoom-out');}},{label:'Actual Size',accelerator:'CmdOrCtrl+0',click:()=>{if(!locked)send('tab-command','zoom-reset');}},{type:'separator'},{label:'Previous Card',accelerator:'CmdOrCtrl+[',click:()=>{if(!locked)send('deck-command',{step:-1});}},{label:'Next Card',accelerator:'CmdOrCtrl+]',click:()=>{if(!locked)send('deck-command',{step:1});}},{label:'Companion Card',accelerator:'Ctrl+Tab',click:()=>{if(!locked)send('deck-command',{companion:true});}},...[1,2,3,4,5,6,7,8,9].map(n=>({label:'Card '+n,accelerator:'CmdOrCtrl+'+n,click:()=>{if(!locked)send('deck-command',{slot:n-1});}}))]},{label:'View',submenu:[{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]}]));
  win.webContents.on('will-navigate', e => e.preventDefault());
  attachContextMenu(win.webContents,()=>'your workspace');
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.on('close',()=>{quitting=true;for(const key of [...views.keys()]){try{views.get(key)?.view.webContents.removeAllListeners('will-prevent-unload');destroyView(key);}catch{}}try{peekClose();}catch{}});
  win.on('closed',() => { try{terminal?.kill();}catch{} try{chat.stop();}catch{} for(const key of [...views.keys()]){try{destroyView(key);}catch{}} });
  win.webContents.on('will-prevent-unload',e=>{if(quitting)e.preventDefault();});
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
  ipcMain.on('document-collapse',e=>{try{documentTrusted(e);documentView.setVisible(false);documents.close();send('document-collapse');}catch{}});
  ipcMain.on('document-selection',(e,payload)=>{try{documentTrusted(e);const text=payload?.text;if(typeof text!=='string' || !text.trim())return;if(payload.target==='task')taskFromSelection(text,{kind:'document'});else send('claude-context',{text:text.slice(0,20000),source:'the document',from:{kind:'document'}});}catch{}});
  handle('show-group-popover',input=>{if(!input || typeof input.folderId!=='string' || !Number.isFinite(input.left) || !Number.isFinite(input.top))throw Error('Invalid popover request');return showPopover({folderId:input.folderId,left:input.left,top:input.top,above:Boolean(input.above)});});
  handle('hide-group-popover',()=>{hidePopover();return true;});
  ipcMain.on('popover-size',(e,size)=>{try{popoverTrusted(e);if(size && Number.isFinite(size.width) && Number.isFinite(size.height))placePopover(size);}catch{}});
  ipcMain.on('popover-open',(e,key)=>{try{popoverTrusted(e);hidePopover();if(typeof key==='string' && (config.services || []).some(s=>(s.id || s.url)===key))send('open-service',key);}catch{}});
  ipcMain.on('popover-edit',(e,id)=>{try{popoverTrusted(e);hidePopover();if(typeof id==='string' && (config.serviceFolders || []).some(f=>f.id===id))send('edit-group',id);}catch{}});
  ipcMain.on('popover-close',e=>{try{popoverTrusted(e);hidePopover();}catch{}});
  ipcMain.on('pane-search',e=>{const i=badges.findIndex(b=>b && b.view.webContents===e.sender);if(i>=0 && !locked)send('deck-command',{search:i});});
  handle('search-used',async()=>{config.searchUses=(config.searchUses || 0)+1;await persist();if(!badgeLabelled())for(const b of badges)if(b && !b.view.webContents.isDestroyed())b.view.webContents.send('badge-labelled',false);return true;});
  ipcMain.on('pane-close',e=>{const i=badges.findIndex(b=>b && b.view.webContents===e.sender);if(i>=0 && !locked)send('deck-command',{close:i});});
  ipcMain.on('popover-remove',async (e,input)=>{try{popoverTrusted(e);if(!input || typeof input.key!=='string' || typeof input.folderId!=='string')return;config.services=setFolder(config.services || [],input.key,null,config.serviceFolders || []);await persist();send('sidebar-changed',{services:config.services,folders:config.serviceFolders || []});const cb=win.getContentBounds();await showPopover({folderId:input.folderId,left:popover.__anchor.x-cb.x,top:popover.__anchor.y-cb.y});}catch{}});
  win.on('move',()=>hidePopover());win.on('resize',()=>hidePopover());
  handle('document-capture-all',()=>{dc.send('capture-selection','claude-all');return true;});
  handle('document-bounds',box=>{if(!box || box.visible===false){documentView.setVisible(false);return;}const [w,h]=win.getContentSize();if(!['x','y','width','height'].every(k=>Number.isFinite(box[k])))throw Error('Invalid document bounds');const x=Math.max(0,Math.min(w,Math.round(box.x))),y=Math.max(0,Math.min(h,Math.round(box.y)));win.contentView.addChildView(documentView);documentView.setBounds({x,y,width:Math.max(0,Math.min(w-x,Math.round(box.width))),height:Math.max(0,Math.min(h-y,Math.round(box.height)))});if(typeof documentView.setBorderRadius==='function')try{documentView.setBorderRadius(12);}catch{}documentView.setVisible(!locked);});
  handle('document-request-open',()=>{dc.send('open-request');return true;});
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
  handle('appearance',async ({theme,mode,layout})=>{if(theme && !['light','dark'].includes(theme))throw Error('Invalid theme');if(mode && !['chat','terminal','files'].includes(mode))throw Error('Invalid mode');if(layout && typeof layout==='object')config.layout=validLayout(layout);if(theme){config.theme=theme;nativeTheme.themeSource=theme;retheme();}if(mode)config.mode=mode;await persist();return true;});
  handle('chat-send',async (prompt,meta)=>{if(!CLAUDE_SUPPORTED)throw Error(CLAUDE_UNAVAILABLE);if(!claudeRoot)throw Error('Choose a Claude workspace first');if(terminal)throw Error('Stop the terminal session before sending a chat message');if(chat.state.busy)throw Error('Wait for the current reply');const sandbox=await prepareClaudeSandbox({fs,root:claudeRoot,mode:config.claudePolicy || 'notes',userData:app.getPath('userData'),packageRoot:__dirname,nodePath:findNode(),claudePath:findClaude(),configDir:claudeConfigDir});const openApps=(config.services || []).filter(openable).map(s=>s.name);chat.run(prompt,claudeRoot,sandbox.executable,{from:cleanFrom(meta?.from),apps:openApps}).catch(error=>send('notice',error.message));return true;});
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
  handle('set-zoom',async ({key,step,reset}={})=>{if(typeof key!=='string' || !serviceItem(key))throw Error('App not found');config.zoom=config.zoom || {};let index=ZOOM_STEPS.indexOf(zoomFor(key));if(reset)index=ZOOM_STEPS.indexOf(1);else if(step===1 || step===-1)index=Math.max(0,Math.min(ZOOM_STEPS.length-1,index+step));else throw Error('Invalid zoom step');const factor=ZOOM_STEPS[index];if(factor===1)delete config.zoom[key];else config.zoom[key]=factor;await persist();applyZoom(key);return factor;});
  handle('recent-clear',()=>{recent.length=0;return [];});
  handle('tour-done',async()=>{config.tourDone=true;await persist();return true;});
  ipcMain.on('web-context-selection',(e,payload)=>{try{const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry || locked)return;const text=String(payload?.text || '').trim();const link=typeof payload?.link==='string' && /^https?:/i.test(payload.link)?payload.link:'';if(!text && !link)return;e.sender.__preloadMenuAt=Date.now();const name=notificationSources.get(e.sender)?.name || 'the web app';const items=[];if(text)items.push({label:'Send Selection to Claude',click:()=>send('claude-context',{text:text.slice(0,20000),source:name,from:fromContents(e.sender)})},{label:'Send Selection to Tasks',click:()=>taskFromSelection(text,fromContents(e.sender))},{type:'separator'});if(link)items.push({label:'Open Link in Quick Look',click:()=>peekOpen(entry.serviceKey,null,link)},{label:'Open Link in New Tab',click:()=>openTab(entry.serviceKey,link,true)},{label:'Copy Link',click:()=>clipboard.writeText(link)},{type:'separator'});if(payload.editable)items.push({role:'cut'},{role:'copy'},{role:'paste'});else if(text)items.push({role:'copy'});if(items.at(-1)?.type==='separator')items.pop();Menu.buildFromTemplate(items).popup({window:win});}catch{}});
  // Deliver text into an app's composer (draft only; the user sends).
  const deliveries=new Map();
  ipcMain.on('web-deliver-result',(e,result)=>{const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry || !result?.id)return;const waiting=deliveries.get(result.id);if(waiting){deliveries.delete(result.id);waiting(result);}});
  handle('deliver-text',async ({serviceKey,tabId,text,mode}={})=>{if(typeof text!=='string' || !text.trim())throw Error('Nothing to paste');const item=serviceItem(serviceKey);if(!item)throw Error('App not found');const tabs=tabsFor(serviceKey);const id=tabId && tabs.items.some(t=>t.id===tabId)?tabId:tabs.active;const entry=ensureView(serviceKey,id);if(!entry)throw Error('That app has nothing open yet');const contents=entry.view.webContents;if(contents.isLoading())await new Promise(r=>{contents.once('did-stop-loading',r);setTimeout(r,8000);});const reqId=crypto.randomUUID();const result=await new Promise(resolve=>{deliveries.set(reqId,resolve);setTimeout(()=>{if(deliveries.delete(reqId))resolve({ok:false,reason:'The app did not respond.'});},12000);contents.send('web-deliver',{id:reqId,text:text.slice(0,20000),mode:mode==='reply'?'reply':'compose'});});if(!result.ok)throw Error(result.reason || 'Could not paste there');contents.focus();return {serviceKey,tabId:id};});
  ipcMain.on('web-items',(e,items)=>{try{const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry || e.senderFrame!==e.sender.mainFrame)return;const source=notificationSources.get(e.sender);if(!source?.saved)return;const clean=(Array.isArray(items)?items:[]).slice(0,8).map(i=>({title:String(i?.title || '').slice(0,120),sub:String(i?.sub || '').slice(0,60),url:/^https?:/i.test(String(i?.url || ''))?String(i.url).slice(0,2000):''})).filter(i=>i.title);source.items=clean;source.itemsAt=Date.now();send('now-changed',nowFeed());}catch{}});
  ipcMain.on('web-notification',(e,payload)=>{try{const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry || e.senderFrame!==e.sender.mainFrame)return;const source=notificationSources.get(e.sender);if(!source?.saved || isMuted(entry.serviceKey))return;const title=String(payload?.title || '').slice(0,200),body=String(payload?.body || '').slice(0,500);if(!title && !body)return;pushRecent({key:entry.serviceKey,tabId:entry.tabId,name:source.name,title,body,added:1,count:visibleBadge(entry.serviceKey)});}catch{}});
  ipcMain.on('web-message',(e,payload)=>{try{const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry || e.senderFrame!==e.sender.mainFrame || entry.visible)return;const source=notificationSources.get(e.sender);if(!source?.saved || isMuted(entry.serviceKey))return;const text=String(payload?.text || '').slice(0,300),sender=String(payload?.sender || '').slice(0,80);if(!text)return;if(recent[0] && recent[0].key===entry.serviceKey && recent[0].body===text)return;pushRecent({key:entry.serviceKey,tabId:entry.tabId,name:source.name,title:sender,body:text,added:1,count:visibleBadge(entry.serviceKey)});if(!source.notificationPermission && Notification.isSupported()){const alert=new Notification({title:source.name+(sender?' · '+sender:''),body:text,silent:false});alert.on('click',()=>{win.show();win.focus();send('open-service',entry.serviceKey);});alert.show();}}catch{}});
  ipcMain.on('web-unread',(e,count)=>{try{const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry || e.senderFrame!==e.sender.mainFrame)return;const source=notificationSources.get(e.sender);if(!source?.saved)return;const n=Math.max(0,Math.min(9999,Number(count) || 0));if(source.domUnread===n)return;source.domUnread=n;const previous=serviceBadges.get(entry.serviceKey) || 0;const merged=Math.max(unreadCount(e.sender.getTitle()),n);updateServiceBadge(entry.serviceKey,merged);if(merged>previous && !entry.visible && !isMuted(entry.serviceKey))pushRecent({key:entry.serviceKey,name:source.name,count:merged});}catch{}});
  handle('peek-bounds',box=>{if(!box || !['x','y','width','height'].every(k=>Number.isFinite(box[k])))throw Error('Invalid peek bounds');peekPlace(box);return true;});
  handle('peek-close',()=>{peekClose();return true;});
  if(!app.isPackaged)handle('debug-views',()=>({tiles:[...views.values()].map(v=>({key:v.serviceKey.slice(0,8),tab:v.tabId.slice(0,6),visible:v.visible,bounds:v.view.getBounds(),peeked:appPeek===v})),peek:peek?{visible:peek.visible,bounds:peek.view.getBounds()}:null,badges:badges.map(b=>b&&b.visible?b.view.getBounds():null)}));
  handle('peek-action',({action}={})=>{if(appPeek){const key=appPeek.serviceKey,tabId=appPeek.tabId;if(action==='tab' || action==='beside'){peekClose();return {serviceKey:key,tabId,tabs:tabsFor(key),beside:action==='beside'};}if(action==='reload'){appPeek.view.webContents.reload();return true;}return null;}if(!peek)return null;const c=peek.view.webContents;if(action==='back' && c.navigationHistory.canGoBack()){c.navigationHistory.goBack();return true;}if(action==='reload'){c.reload();return true;}const url=c.getURL(),key=peek.serviceKey;if(!/^https?:/i.test(url))return null;if(action==='tab'){const opened=openTab(key,url,true);peekClose();return opened;}if(action==='beside'){const opened=openTab(key,url,false);peekClose();return {...opened,beside:true};}return null;});
  handle('set-peek-links',async on=>{config.peekLinks=Boolean(on);await persist();return config.peekLinks;});
  ipcMain.on('web-peek-link',(e,url)=>{try{const entry=[...views.values()].find(v=>v.view.webContents===e.sender);if(!entry || locked || typeof url!=='string' || !/^https?:/i.test(url))return;peekOpen(entry.serviceKey,null,url);}catch{}});
  ipcMain.handle('web-password-request',async e=>{const url=webViewOrigin(e);if(!url || locked)return null;const saved=await passwords.get(url);if(saved)passwords.touch(url,saved.username).catch(()=>{});return saved?{username:saved.username,password:saved.password}:null;});
  ipcMain.on('web-password-submitted',async (e,payload)=>{try{const url=webViewOrigin(e);if(!url || locked || !payload || typeof payload.password!=='string' || !payload.password)return;if(await passwords.isNever(url))return;const existing=await passwords.get(url);const username=String(payload.username || '').slice(0,300);if(existing && existing.username===username && existing.password===payload.password)return;const id=crypto.randomUUID();passwordOffers.set(id,{url,username,password:String(payload.password).slice(0,1000)});setTimeout(()=>passwordOffers.delete(id),120000).unref?.();send('password-offer',{id,host:new URL(url).host,username,update:Boolean(existing)});}catch{}});
  handle('password-decide',async ({id,decision}={})=>{const offer=passwordOffers.get(id);passwordOffers.delete(id);if(!offer)return false;if(decision==='save')await passwords.set(offer.url,offer.username,offer.password);else if(decision==='never')await passwords.never(offer.url);return true;});
  handle('passwords-list',()=>passwords.list());
  handle('password-remove',({origin,username}={})=>passwords.remove(String(origin),String(username)));
  handle('passwords-clear',()=>passwords.clear());
  // The visible text of an open tab, for "Ask Claude about this tab". Only tabs the user has open; capped, whitespace-collapsed.
  handle('tab-text',async ({serviceKey,tabId}={})=>{tabOf(serviceKey,tabId);const entry=views.get(viewKey(serviceKey,tabId));if(!entry)throw Error('That tab is not loaded');const c=entry.view.webContents;const text=await c.executeJavaScript("(()=>{const t=(document.body?.innerText||'');return {title:document.title,url:location.href,text:t.replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').slice(0,60000)};})()",true);return {title:String(text.title || '').slice(0,300),url:String(text.url || ''),text:String(text.text || '')};});
  handle('save-preset',async ({name,tiles}={})=>{if(typeof name!=='string' || !name.trim())throw Error('Give the layout a name');const clean=validLayout({tiles}).tiles;config.presets=(config.presets || []).filter(p=>p.name!==name.trim().slice(0,40));config.presets.push({id:crypto.randomUUID(),name:name.trim().slice(0,40),tiles:clean});if(config.presets.length>20)config.presets.shift();await persist();return config.presets;});
  handle('remove-preset',async id=>{config.presets=(config.presets || []).filter(p=>p.id!==id);await persist();return config.presets;});
  // Ask every loaded app to re-read its unread state right now (Home's Now strip refresh, or returning to Home).
  handle('now-refresh',()=>{for(const entry of views.values()){const c=entry.view.webContents;if(!c.isDestroyed() && !c.isLoading())c.send('web-probe-now');}nowSoon();return true;});
  handle('set-mute',async ({key,hours}={})=>{if(typeof key!=='string' || !serviceItem(key))throw Error('App not found');config.mutes=config.mutes || {};if(hours===null || hours===undefined)delete config.mutes[key];else if(hours==='forever')config.mutes[key]=-1;else{const h=Number(hours);if(!Number.isFinite(h) || h<=0 || h>24*365)throw Error('Enter a number of hours');config.mutes[key]=Date.now()+Math.round(h*3600000);}await persist();updateServiceBadge(key,serviceBadges.get(key) || 0);return mutes();});
  handle('set-sleep',async ({defaultMinutes,key,minutes}={})=>{const s=sleepSettings();if(defaultMinutes!==undefined){if(!SLEEP_CHOICES.has(defaultMinutes))throw Error('Invalid sleep delay');s.defaultMinutes=defaultMinutes;}if(typeof key==='string'){if(!serviceItem(key) || isBrowserItem(serviceItem(key)))throw Error('App not found');if(minutes===null || minutes===undefined)delete s.apps[key];else if(SLEEP_CHOICES.has(minutes))s.apps[key]=minutes;else throw Error('Invalid sleep delay');}config.sleep=s;await persist();return s;});
  handle('set-service-profile',async ({key,profile})=>{if(!PROFILES.has(profile))throw Error('Invalid browser profile');let found=false;config.services=(config.services || []).map(item=>{if((item.id || item.url)!==key)return item;found=true;return {...item,profile};});if(!found)throw Error('App not found');closeServiceViews(key);await persist();return config.services;});
  handle('isolate-all-services',async()=>{for(const item of config.services || [])if(item.url)closeServiceViews(item.id || item.url);config.services=(config.services || []).map(item=>item.url?{...item,profile:'isolated'}:item);await persist();return config.services;});
  handle('clear-profile-data',async ({profile,key})=>{if(profile==='browser'){const item=serviceItem(key);if(!isBrowserItem(item))throw Error('Browser not found');closeServiceViews(key);delete (config.tabs || {})[key];await clearSessionData(session.fromPartition(browserPartition(key)));await persist();return true;}if(!PROFILES.has(profile))throw Error('Invalid browser profile');if(profile==='isolated' && !(config.services || []).some(item=>(item.id || item.url)===key))throw Error('App not found');for(const item of config.services || [])if(item.url && (item.profile || 'isolated')===profile && (profile!=='isolated' || (item.id || item.url)===key))closeServiceViews(item.id || item.url);await clearSessionData(session.fromPartition(partitionFor(profile,key)));return true;});
  handle('clear-claude-history',async()=>{if(chat.state.busy)throw Error('Stop Claude before clearing history');config.chats={};chat.restore(null);chat.publish();await persist();return true;});
  handle('erase-hearth-data',async()=>{if(chat.state.busy || terminal)throw Error('Stop Claude before erasing Just Zen data');const partitions=new Set([partitionFor('shared'),partitionFor('personal'),partitionFor('work'),BROWSER_PARTITION]);for(const item of config.services || []){if(isBrowserItem(item))partitions.add(browserPartition(item.id));else if(item.url)partitions.add(partitionFor(item.profile || 'isolated',item.id || item.url));}for(const key of [...views.keys()])destroyView(key);for(const name of partitions)await clearSessionData(session.fromPartition(name));config={theme:config.theme || 'light'};root=null;claudeRoot=null;chat.restore(null);chat.publish();await fs.rm(path.join(app.getPath('userData'),'favicons'),{recursive:true,force:true});await fs.rm(path.join(app.getPath('userData'),'claude-sandbox'),{recursive:true,force:true});await fs.rm(claudeConfigDir,{recursive:true,force:true});await passwords.clear();
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
  handle('remove-service-folder',async id=>{const folder=(config.serviceFolders || []).find(f=>f.id===id);const index=(config.serviceFolders || []).findIndex(f=>f.id===id);const members=(config.services || []).filter(s=>s.folderId===id).map(s=>s.id || s.url);const next=removeFolder(config.services || [],config.serviceFolders || [],id);config.services=next.services;config.serviceFolders=next.folders;await persist();return {services:config.services,folders:config.serviceFolders,snapshot:{folder,index,members}};});
  handle('restore-service-folder',async snapshot=>{if(!snapshot?.folder || typeof snapshot.folder.id!=='string')throw Error('Nothing to restore');if((config.serviceFolders || []).some(f=>f.id===snapshot.folder.id))return {services:config.services || [],folders:config.serviceFolders};const folder=createFolder([],snapshot.folder.name,snapshot.folder.id,snapshot.folder.icon)[0];folder.collapsed=true;config.serviceFolders=config.serviceFolders || [];config.serviceFolders.splice(Math.max(0,Math.min(config.serviceFolders.length,Number(snapshot.index) || 0)),0,folder);for(const key of Array.isArray(snapshot.members)?snapshot.members:[])try{config.services=setFolder(config.services || [],key,folder.id,config.serviceFolders);}catch{}await persist();return {services:config.services,folders:config.serviceFolders};});
  handle('set-service-folder',async ({key,folderId})=>{config.services=setFolder(config.services || [],key,folderId,config.serviceFolders || []);await persist();return {services:config.services,folders:config.serviceFolders || []};});
  handle('toggle-service-folder',async id=>{let found=false;config.serviceFolders=(config.serviceFolders || []).map(folder=>{if(folder.id!==id)return folder;found=true;return {...folder,collapsed:!folder.collapsed};});if(!found)throw Error('Group not found');await persist();return {services:config.services || [],folders:config.serviceFolders};});
  handle('add-todo',async input=>{const text=typeof input==='string'?input:input?.text;if(typeof text!=='string' || !text.trim())throw Error('Enter a task');addTask(text,typeof input==='object'?input.from:null);await persist();return config.todos;});
  handle('add-todos',async ({texts,from}={})=>{if(!Array.isArray(texts))throw Error('Nothing to add');let n=0;for(const t of texts.slice(0,50)){try{addTask(t,from);n++;}catch{}}await persist();return {todos:config.todos,added:n};});
  handle('delete-todo',async id=>{const index=(config.todos || []).findIndex(t=>t.id===id);if(index<0)throw Error('Task not found');const [todo]=config.todos.splice(index,1);await persist();return {todos:config.todos,snapshot:{todo,index}};});
  handle('restore-todo',async snapshot=>{const todo=snapshot?.todo;if(!todo || typeof todo.id!=='string' || typeof todo.text!=='string')throw Error('Nothing to restore');config.todos=config.todos || [];if(config.todos.some(t=>t.id===todo.id))return config.todos;config.todos.splice(Math.max(0,Math.min(config.todos.length,Number(snapshot.index) || 0)),0,{id:todo.id,text:todo.text.slice(0,300),done:Boolean(todo.done),createdAt:Number(todo.createdAt) || Date.now(),doneAt:todo.doneAt || null});await persist();return config.todos;});
  handle('toggle-todo',async id=>{let found=false;config.todos=(config.todos || []).map(todo=>{if(todo.id!==id)return todo;found=true;const done=!todo.done;return {...todo,done,doneAt:done?Date.now():null};});if(!found)throw Error('Task not found');await persist();return config.todos;});
  handle('whiteboard-add-note',async ({text,html}={})=>{const board=config.whiteboard || {items:[],camera:{x:0,y:0,zoom:1}};board.items=board.items || [];if(board.items.length>=1000)throw Error('The whiteboard is full');const notes=board.items.filter(i=>i.type==='note');const cam=board.camera || {x:0,y:0,zoom:1};const note={id:crypto.randomUUID(),type:'note',x:cam.x+60+(notes.length%4)*40,y:cam.y+80+(notes.length%4)*30,w:260,h:200,text:String(text || '').slice(0,4000),color:['#fff0a8','#dcecff','#dff2df','#f7dfe5'][notes.length%4],rotation:0};if(typeof html==='string' && html.length<20000)note.html=html;board.items.push(note);config.whiteboard=validWhiteboard(board);await persist();send('whiteboard-changed',config.whiteboard);return note.id;});
  handle('save-whiteboard',async value=>{config.whiteboard=validWhiteboard(value);await persist();return true;});
  handle('favicon',async key=>{const item=(config.services || []).find(s=>(s.id || s.url)===key);const local=bundledIcon(item);if(local)return 'data:image/png;base64,'+(await fs.readFile(path.join(__dirname,local))).toString('base64');return item?.url?favicon(item.url):null;});
  handle('web-apps',()=>catalogue.map(item=>({...item,added:isAdded(config.services || [],item)})));
  handle('add-catalog-app',async id=>{config.services=addApp(config.services || [],id);await persist();return config.services;});
  // Removals return a snapshot the renderer can hand back to 'restore-service' within the undo window; cookies are untouched.
  handle('remove-service',async key=>{const index=(config.services || []).findIndex(s=>(s.id || s.url)===key);if(index<0)throw Error('App not found');const item=config.services[index];closeServiceViews(key);config.services=config.services.filter((_,i)=>i!==index);const snapshot={item,index,tabs:(config.tabs || {})[key] || null,sleep:config.sleep?.apps?.[key],zoom:config.zoom?.[key],mute:config.mutes?.[key]};delete (config.tabs || {})[key];if(config.sleep?.apps)delete config.sleep.apps[key];if(config.zoom)delete config.zoom[key];if(config.mutes)delete config.mutes[key];await persist();return {services:config.services,snapshot};});
  handle('restore-service',async snapshot=>{if(!snapshot || !snapshot.item || typeof snapshot.item!=='object')throw Error('Nothing to restore');const item=snapshot.item;const key=item.id || item.url;if(typeof key!=='string' || (config.services || []).some(s=>(s.id || s.url)===key))return config.services || [];if(item.url)validURL(item.url);const clean={...item,name:String(item.name || '').slice(0,50)};config.services=config.services || [];const at=Math.max(0,Math.min(config.services.length,Number(snapshot.index) || 0));config.services.splice(at,0,clean);if(snapshot.tabs && cleanTabs(key,snapshot.tabs)){config.tabs=config.tabs || {};config.tabs[key]=cleanTabs(key,snapshot.tabs);}if(SLEEP_CHOICES.has(snapshot.sleep)){config.sleep=sleepSettings();config.sleep.apps[key]=snapshot.sleep;}if(typeof snapshot.zoom==='number'){config.zoom=config.zoom || {};config.zoom[key]=snapshot.zoom;}if(snapshot.mute===-1 || (typeof snapshot.mute==='number' && snapshot.mute>Date.now())){config.mutes=config.mutes || {};config.mutes[key]=snapshot.mute;}await persist();return config.services;});
  handle('add-browser',async ({name,icon}={})=>{if(typeof name!=='string' || !name.trim())throw Error('Name is required');config.services=config.services || [];const item={id:crypto.randomUUID(),kind:'browser',name:name.trim().slice(0,50),icon:cleanEmoji(icon),profile:'isolated'};config.services.push(item);await persist();return {services:config.services,key:item.id};});
  handle('update-service',async ({key,name,icon,pinned,mobile}={})=>{let found=false;config.services=(config.services || []).map(item=>{if((item.id || item.url)!==key)return item;found=true;const next={...item};if(typeof name==='string' && name.trim())next.name=name.trim().slice(0,50);if(icon!==undefined && isBrowserItem(item))next.icon=cleanEmoji(icon);if(typeof pinned==='boolean')next.pinned=pinned;if(typeof mobile==='boolean')next.mobile=mobile;return next;});if(!found)throw Error('App not found');await persist();return config.services;});
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
  handle('media-grants',()=>Object.entries(config.mediaGrants || {}).map(([k,v])=>{const i=k.indexOf(' ');const key=k.slice(0,i),origin=k.slice(i+1);return {key,name:serviceItem(key)?.name || key,origin,allowed:v};}));
  handle('media-forget',async k=>{if(config.mediaGrants && typeof k==='string')delete config.mediaGrants[k];await persist();return true;});
  handle('reveal-download',p=>{if(typeof p!=='string' || !path.isAbsolute(p))throw Error('Invalid path');shell.showItemInFolder(p);return true;});
  handle('test-notification',()=>{if(!Notification.isSupported())throw Error('Notifications are not supported on this Mac');const n=new Notification({title:'Just Zen',body:'Notifications are working. If you did not see this, allow Just Zen in System Settings → Notifications.'});n.show();return true;});
  handle('check-updates',()=>{if(!updates.checkNow)throw Error(updates.reason==='development'?'Update checks are off in a development build.':'Updates are not available in this build.');updates.checkNow();return true;});
  const sleeper=setInterval(()=>{sleepSweep();expireMutes();},30_000);sleeper.unref?.();
  setTimeout(warmChatApps,6000).unref?.();
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
      await win.webContents.executeJavaScript(`document.querySelector('#layout-switch [data-tiles="2h"]').click()`);await new Promise(r=>setTimeout(r,400));await win.webContents.executeJavaScript(`(async()=>{document.querySelectorAll('#tiles .tile')[1].querySelector('.pane-search').click();await new Promise(r=>setTimeout(r,200));[...document.querySelectorAll('.app-tile')].find(t=>t.textContent.includes('A document')).click();})()`);await new Promise(r=>setTimeout(r,800));
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
// Closing the window quits. If anything stalls the quit (a child process, a pending dialog), force the exit so a relaunch starts clean.
function warmChatApps(){if(locked)return;for(const item of (config.services || []).filter(openable)){if(!isChatItem(item))continue;const key=item.id || item.url;for(const tab of tabsFor(key).items){try{ensureView(key,tab.id);}catch{}}}}
let quitting=false;
app.on('window-all-closed',()=>{quitting=true;app.quit();setTimeout(()=>app.exit(0),2500);});
app.on('before-quit',()=>{quitting=true;setTimeout(()=>app.exit(0),4000);});
// Dock click with no window left (a quit that stalled): start over rather than sit there.
app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length){app.relaunch();app.exit(0);}});
// Cookies are written to disk on quit, so a login made moments before closing survives.
app.on('before-quit',()=>{for(const view of views.values()){try{view.view.webContents.session.cookies.flushStore().catch(()=>{});}catch{}}});
setInterval(()=>{for(const target of hardenedSessions){try{target.cookies.flushStore().catch(()=>{});}catch{}}},30000).unref?.();
