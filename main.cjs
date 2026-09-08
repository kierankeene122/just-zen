const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme, net, nativeImage, safeStorage, systemPreferences, session, Notification } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const crypto=require('node:crypto');
const pty = require('node-pty');
const {ChatSession} = require('./chat.cjs');
const {catalogue,findApp,isAdded,addApp,bundledIcon} = require('./app-catalog.cjs');
const {webPreferences,ephemeralWebPreferences,configureWebContents,PROFILES,partitionFor} = require('./web-session.cjs');
const {reorder,createFolder,setFolder}=require('./sidebar.cjs');
const {createFaviconCache}=require('./favicons.cjs');
const {startAutoUpdates}=require('./auto-update.cjs');
const {createSecureStore}=require('./secure-store.cjs');
const {prepareClaudeSandbox}=require('./claude-sandbox.cjs');
const {canNotify,unreadCount,secureOrigin}=require('./notifications.cjs');
const {findNode}=require('./node-runtime.cjs');
const {createImageDecoder}=require('./image-decoder.cjs');
const {describeUpdateState}=require('./update-state.cjs');
let favicon;
let chat;
let browserBounds={x:252,y:192,width:500,height:600};
const browsers=new Map();
const notificationSources=new WeakMap(),notificationOrigins=new WeakMap(),serviceBadges=new Map();
const { pathToFileURL } = require('node:url');
let win, browser, terminal, root = null, claudeRoot = null, config = {}, browserVisible = false, secureStore, locked=false, lockTimer=null;
const entry = pathToFileURL(path.join(__dirname, 'index.html')).href;
// Test hooks are development-only: a packaged app ignores --smoke and HEARTH_DATA.
const smoke = process.argv.includes('--smoke') && !app.isPackaged;
// Storage stays stable when the executable is rebuilt or packaged by a different release tool.
// HEARTH_DATA is reserved for isolated smoke and visual-test profiles.
app.setPath('userData',(!app.isPackaged && process.env.HEARTH_DATA) || path.join(app.getPath('appData'),'Hearth'));
// The smoke test mutates state (lock, sidebar, whiteboard, folders), so it always runs in a fresh throwaway profile.
if(smoke)app.setPath('userData',require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(),'hearth-smoke-')));
// Claude Code login, settings and history used by Just Zen live here, separate from the user's own ~/.claude.
const claudeConfigDir=path.join(app.getPath('userData'),'claude-config');
let unlockFailures=0,unlockBlockedUntil=0;
app.on('certificate-error',(event,_contents,_url,_error,_certificate,callback)=>{event.preventDefault();callback(false);});
let writeQueue=Promise.resolve();
function persist(){writeQueue=writeQueue.catch(()=>{}).then(()=>secureStore.save(config));return writeQueue;}
function trusted(event) { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== entry) throw Error('Untrusted request'); }
const LOCK_ALLOWED=new Set(['state','security-status','unlock-app']);
function handle(name, fn) { ipcMain.handle(name, async (e, ...args) => { trusted(e);if(locked && !LOCK_ALLOWED.has(name))throw Error('Just Zen is locked'); return fn(...args); }); }
function send(name, value) { if (win && !win.isDestroyed()) win.webContents.send(name, value); }
function touchIDAvailable(){return process.platform==='darwin' && Boolean(systemPreferences.canPromptTouchID?.());}
function scheduleLock(){clearTimeout(lockTimer);if(!config.appLock || locked)return;lockTimer=setTimeout(()=>lockApp(),Math.max(1,Number(config.autoLockMinutes) || 15)*60_000);lockTimer.unref?.();}
function lockApp(){if(!config.appLock || locked)return false;locked=true;showBrowser(false);for(const view of win.contentView.children)if(view.webContents?.getURL().endsWith('/document-view.html'))view.setVisible(false);send('app-locked',{locked:true,method:config.appLockMethod});return true;}
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
function stateSnapshot(){if(locked)return {locked:true,lockMethod:config.appLockMethod || 'touchID',theme:config.theme || 'light',version:app.getVersion()};return {locked:false,root,claudeRoot,claudePolicy:config.claudePolicy || 'full',claudeWorkspaces:config.claudeWorkspaces || (claudeRoot?[claudeRoot]:[]),connectedFolders:[...new Set([root,...(config.connectedFolders || []),...(config.claudeWorkspaces || [])].filter(Boolean))],services:config.services || [],serviceFolders:config.serviceFolders || [],serviceBadges:Object.fromEntries(serviceBadges),todos:config.todos || [],whiteboard:config.whiteboard || {items:[]},version:app.getVersion(),theme:config.theme || 'light',mode:config.mode || 'chat',layout:config.layout || {},chat:chat.snapshot()};}
function validWhiteboard(value){if(!value || !Array.isArray(value.items) || value.items.length>1000)throw Error('Invalid whiteboard');const camera=value.camera || {x:0,y:0,zoom:1};if(![camera.x,camera.y,camera.zoom].every(Number.isFinite) || camera.zoom<.2 || camera.zoom>3)throw Error('Invalid whiteboard view');const raw=JSON.stringify({items:value.items,camera:{x:camera.x,y:camera.y,zoom:camera.zoom}});if(raw.length>2_000_000)throw Error('Whiteboard is too large');const types=new Set(['path','note','text','rectangle','ellipse','arrow']);for(const item of value.items){if(!item || typeof item.id!=='string' || item.id.length>100 || !types.has(item.type))throw Error('Invalid whiteboard item');}return JSON.parse(raw);}
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
function bounds(){if(browser && browserVisible)browser.setBounds(browserBounds);}
function showBrowser(visible) { browserVisible = visible; if (browser) browser.setVisible(visible); bounds(); }
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
  try{await fs.access(path.join(process.resourcesPath,'app-update.yml'));result.updates='Configured release feed';}catch{result.updates=describeUpdateState(await fs.readFile(path.join(app.getPath('userData'),'update-state.json'),'utf8').then(JSON.parse).catch(()=>null));}
 }
 const profiles={shared:0,personal:0,work:0,isolated:0};for(const item of config.services || [])if(item.url)profiles[item.profile || 'isolated']++;
 return {...result,encrypted:Boolean(secureStore?.available()),profiles,claude:{connected:Boolean(claudeRoot),policy:config.claudePolicy || 'full',sandboxed:true,terminalSandboxed:false},lock:{enabled:Boolean(config.appLock),locked,touchID:touchIDAvailable(),method:config.appLockMethod || (touchIDAvailable()?'touchID':'passcode'),minutes:Number(config.autoLockMinutes) || 15}};
}
function closeServiceViews(serviceKey){for(const [key,view] of browsers)if(key.startsWith('service:'+serviceKey+':')){if(browser===view){browser=null;browserVisible=false;}view.webContents.close();browsers.delete(key);}updateServiceBadge(serviceKey,0);}
async function browse(request,legacyForce=false) {
  const input=typeof request==='string'?{url:request,force:legacyForce}:request || {};
  const url=validURL(input.url),serviceKey=typeof input.serviceKey==='string'?input.serviceKey:null;
  const item=serviceKey?(config.services || []).find(service=>(service.id || service.url)===serviceKey):null;
  const profile=item?.profile || 'isolated';
  const force=Boolean(input.force),background=Boolean(input.background);
  if(!background && browser)browser.setVisible(false);
  const key=serviceKey?'service:'+serviceKey+':'+profile:'url:'+url;
  let view=browsers.get(key),fresh=!view;
  if(!serviceKey)for(const [other,stale] of browsers)if(other.startsWith('url:') && other!==key){if(browser===stale){browser=null;browserVisible=false;}stale.webContents.close();browsers.delete(other);}
  if(!view){
    const preferences={...(serviceKey?webPreferences(profile,serviceKey):ephemeralWebPreferences(url)),backgroundThrottling:false};
    view=new WebContentsView({webPreferences:preferences});
    browsers.set(key,view);win.contentView.addChildView(view);view.setVisible(false);
    const contents=view.webContents;
    const notificationSource={contents,saved:Boolean(item),key:serviceKey,name:item?.name || 'Website',notificationPermission:false,badgeInitialized:false,origins:new Set(),landed:false};
    notificationSources.set(contents,notificationSource);
    hardenWebSession(contents.session);
    const origins=notificationOrigins.get(contents.session);try{if(item && secureOrigin(url)){origins.add(new URL(url).origin);notificationSource.origins.add(new URL(url).origin);}}catch{}
    configureWebContents(contents,win,message=>send('notice',message),contents,preferences);
    contents.on('page-favicon-updated',async (_e,urls)=>{if(!urls.length || !item || bundledIcon(item))return;const icon=await favicon(item.url,urls[0]);if(icon)send('favicon',{url:item.url,icon});});
    // Origins reached by the app's initial redirect chain may notify; later navigations (open redirects, links) may not.
    contents.on('did-navigate',(_e,url)=>{if(browser===view)send('browser-url',url);try{if(item && !notificationSource.landed && secureOrigin(url)){origins.add(new URL(url).origin);notificationSource.origins.add(new URL(url).origin);}}catch{}contents.session.cookies.flushStore().catch(()=>{});});
    contents.once('did-finish-load',()=>{notificationSource.landed=true;});
    contents.on('did-fail-load',(_e,code,description)=>{if(code!==-3)send('notice','Page could not load: '+description);});
    contents.on('page-title-updated',(_event,title)=>{
      if(!item)return;
      const count=unreadCount(title),previous=serviceBadges.get(serviceKey) || 0;
      updateServiceBadge(serviceKey,count);
      if(notificationSource.badgeInitialized && count>previous && !notificationSource.notificationPermission && Notification.isSupported()){
        const alert=new Notification({title:item.name,body:count===1?'1 unread message':count+' unread messages',silent:false});
        alert.on('click',()=>{win.show();win.focus();send('open-service',serviceKey);});alert.show();
      }
      notificationSource.badgeInitialized=true;
    });
  }
  if(!background){browser=view;showBrowser(true);}
  if(fresh || force)view.webContents.loadURL(url).catch(()=>{});
  else if(!background)send('browser-url',view.webContents.getURL());
  return {fresh,loading:view.webContents.isLoading()};
}
function subscriptionEnv(){
  const env={...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',PATH:'/opt/homebrew/bin:/usr/local/bin:'+process.env.PATH,CLAUDE_CONFIG_DIR:claudeConfigDir};
  delete env.ELECTRON_RUN_AS_NODE;
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[key];
  return env;
}
function startTerminal(kind = 'claude') {
  if (!claudeRoot) throw Error('Choose a Claude workspace first');
  if(kind==='claude' && (config.claudePolicy || 'full')!=='full')throw Error('Claude Terminal requires Full workspace mode. Use Chat for enforced Read-only or Notes-only access.');
  if (terminal) throw Error('A session is already running. Stop it before starting another.');
  if(chat?.state.busy)throw Error('Stop the chat turn before starting a terminal');
  const env=subscriptionEnv();
  terminal = pty.spawn(kind === 'shell' ? '/bin/zsh' : '/opt/homebrew/bin/claude', kind === 'shell' ? ['-l'] : [], {name:'xterm-256color',cols:70,rows:32,cwd:claudeRoot,env});
  const current = terminal;
  current.onData(data => send('terminal-data',data));
  current.onExit(({exitCode}) => { if(terminal === current) terminal = null; send('terminal-exit',exitCode); });
  return true;
}
app.whenReady().then(async () => {
  secureStore=createSecureStore({fs,safeStorage,userData:app.getPath('userData')});
  try { config = await secureStore.load(); if(config.root) root = await fs.realpath(config.root);if(config.claudeRoot)claudeRoot=await fs.realpath(config.claudeRoot);else if(root){claudeRoot=root;config.claudeRoot=root;}if(claudeRoot)config.claudeWorkspaces=[claudeRoot,...(config.claudeWorkspaces || []).filter(value=>value!==claudeRoot)].slice(0,12); } catch(error){console.error(error);config={};}
  const unprofiled=(config.services || []).some(item=>item.url && !item.profile);if(unprofiled){config.services=config.services.map(item=>item.url && !item.profile?{...item,profile:'isolated'}:item);await persist();}
  if(!config.whiteboard && Array.isArray(config.stickyNotes)){config.whiteboard={items:config.stickyNotes.map((note,index)=>({id:note.id || crypto.randomUUID(),type:'note',x:80+(index%4)*245,y:90+Math.floor(index/4)*195,w:220,h:170,text:String(note.text || ''),color:{sun:'#fff0a8',blue:'#dcecff',mint:'#dff2df',rose:'#f7dfe5'}[note.color] || '#fff0a8',rotation:(index%2?1:-1)*.6}))};delete config.stickyNotes;await persist();}
  locked=Boolean(config.appLock);
  favicon=createFaviconCache(path.join(app.getPath('userData'),'favicons'),net,createImageDecoder({BrowserWindow}));
  nativeTheme.themeSource=config.theme || 'light';
  chat=new ChatSession({emit:state=>send('chat-state',state),policy:()=>({mode:config.claudePolicy || 'full',root:claudeRoot}),env:()=>({...subscriptionEnv(),ANTHROPIC_API_KEY:undefined,ANTHROPIC_AUTH_TOKEN:undefined,ANTHROPIC_BASE_URL:undefined,CLAUDE_CODE_USE_BEDROCK:undefined,CLAUDE_CODE_USE_VERTEX:undefined,CLAUDE_CODE_USE_FOUNDRY:undefined}),save:async state=>{if(!claudeRoot)return;config.chats=config.chats || {};config.chats[claudeRoot]=state;await persist();}});
  chat.restore(config.chats?.[claudeRoot]);
  win = new BrowserWindow({show:false,width:1440,height:940,minWidth:1100,minHeight:700,title:'Just Zen',icon:path.join(__dirname,'assets','justzen.png'),titleBarStyle:'hiddenInset',backgroundColor:'#ffffff',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Just Zen',submenu:[{role:'about'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]}]));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.on('resize',bounds);
  win.on('closed',() => { terminal?.kill();chat.stop();for(const view of browsers.values())view.webContents.close(); });
  const documents=require('./documents.cjs').createDocuments(dialog,()=>win);
  const documentEntry=require('node:url').pathToFileURL(path.join(__dirname,'document-view.html')).href;
  const documentView=new WebContentsView({webPreferences:{preload:path.join(__dirname,'document-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'documents-preview'}});
  win.contentView.addChildView(documentView);documentView.setVisible(false);
  const dc=documentView.webContents;
  dc.session.setPermissionRequestHandler((_c,_p,done)=>done(false));dc.session.setPermissionCheckHandler(()=>false);
  const allowedDocumentFiles=new Set(['document-view.html','document-view.css','style.css','document-view.js','document-pane.js','node_modules/dompurify/dist/purify.min.js','node_modules/pdfjs-dist/build/pdf.mjs','node_modules/pdfjs-dist/build/pdf.worker.mjs'].map(f=>require('node:url').pathToFileURL(path.join(__dirname,f)).href));
  dc.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowedDocumentFiles.has(details.url)}));
  dc.setWindowOpenHandler(()=>({action:'deny'}));dc.on('will-navigate',e=>e.preventDefault());dc.on('will-frame-navigate',e=>e.preventDefault());dc.on('will-redirect',e=>e.preventDefault());
  function documentTrusted(e){if(locked || e.sender!==dc || e.senderFrame!==dc.mainFrame || e.senderFrame.url!==documentEntry)throw Error('Untrusted document request');}
  for(const [name,fn] of [['document-open',()=>documents.open()],['document-save',input=>documents.save(input)],['document-close',()=>documents.close()]])ipcMain.handle(name,(e,...args)=>{documentTrusted(e);return fn(...args);});
  ipcMain.on('document-collapse',e=>{try{documentTrusted(e);documentView.setVisible(false);send('document-collapse');}catch{}});
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
    showBrowser(false);
    const result = await dialog.showOpenDialog(win,{title:'Connect a local folder for Files and Claude',properties:['openDirectory']});
    if(result.canceled) return null;
    const selected=await fs.realpath(result.filePaths[0]);config.connectedFolders=[...new Set([selected,root,...(config.connectedFolders || []),...(config.claudeWorkspaces || [])].filter(Boolean))];root=selected;config.root=root;claudeRoot=root;config.claudeRoot=root;config.claudeWorkspaces=[...new Set([root,...(config.claudeWorkspaces || [])])];chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return root;
  });
  handle('select-files-folder',async value=>{if(terminal || chat.state.busy)throw Error('Stop Claude before changing folders');if(!stateSnapshot().connectedFolders.includes(value))throw Error('Unknown folder');const selected=await fs.realpath(value);root=selected;config.root=root;claudeRoot=root;config.claudeRoot=root;config.claudeWorkspaces=[...new Set([root,...(config.claudeWorkspaces || [])])];chat.restore(config.chats?.[root]);chat.publish();await persist();return stateSnapshot();});
  handle('choose-claude-folder',async () => {
    if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing its workspace');
    const result=await dialog.showOpenDialog(win,{title:'Choose the folder Claude may access',properties:['openDirectory']});
    if(result.canceled)return null;
    claudeRoot=await fs.realpath(result.filePaths[0]);config.claudeRoot=claudeRoot;config.claudeWorkspaces=[claudeRoot,...(config.claudeWorkspaces || []).filter(value=>value!==claudeRoot)].slice(0,12);chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return {root:claudeRoot,policy:config.claudePolicy || 'full',workspaces:config.claudeWorkspaces};
  });
  handle('select-claude-folder',async value=>{if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing its workspace');if(typeof value!=='string' || !(config.claudeWorkspaces || []).includes(value))throw Error('Unknown Claude workspace');claudeRoot=await fs.realpath(value);config.claudeRoot=claudeRoot;chat.restore(config.chats?.[claudeRoot]);chat.publish();await persist();return {root:claudeRoot,policy:config.claudePolicy || 'full',workspaces:config.claudeWorkspaces};});
  handle('disconnect-claude-folder',async ()=>{if(terminal || chat.state.busy)throw Error('Stop the current Claude session before disconnecting its workspace');claudeRoot=null;delete config.claudeRoot;chat.restore(null);chat.publish();await persist();return true;});
  handle('set-claude-policy',async mode=>{if(!['full','notes','readOnly'].includes(mode))throw Error('Invalid Claude access mode');if(terminal || chat.state.busy)throw Error('Stop the current Claude session before changing access');config.claudePolicy=mode;await persist();return mode;});
  handle('appearance',async ({theme,mode,layout})=>{if(theme && !['light','dark'].includes(theme))throw Error('Invalid theme');if(mode && !['chat','terminal'].includes(mode))throw Error('Invalid mode');if(layout)config.layout={agentCollapsed:Boolean(layout.agentCollapsed),centreCollapsed:Boolean(layout.centreCollapsed),navCollapsed:Boolean(layout.navCollapsed)};if(theme){config.theme=theme;nativeTheme.themeSource=theme;}if(mode)config.mode=mode;await persist();return true;});
  handle('chat-send',async prompt=>{if(!claudeRoot)throw Error('Choose a Claude workspace first');if(terminal)throw Error('Stop the terminal session before sending a chat message');if(chat.state.busy)throw Error('Wait for the current reply');const sandbox=await prepareClaudeSandbox({fs,root:claudeRoot,mode:config.claudePolicy || 'full',userData:app.getPath('userData'),packageRoot:__dirname,nodePath:findNode(),configDir:claudeConfigDir});chat.run(prompt,claudeRoot,sandbox.executable).catch(error=>send('notice',error.message));return true;});
  handle('chat-stop',()=>chat.stop());
  handle('chat-permission',value=>chat.respond(value));
  handle('chat-new',async ()=>{if(chat.state.busy)throw Error('Stop the current reply first');chat.restore(null);chat.publish();config.chats=config.chats || {};delete config.chats[claudeRoot];await persist();});
  handle('files',files);
  handle('read',async relative => { const file = await localFile(relative); const stat = await fs.stat(file); if(stat.size > 2e6) throw Error('Preview supports text files up to 2 MB'); const text = await fs.readFile(file,'utf8'); if(text.includes('\0')) throw Error('This is a binary file'); return {text}; });
  handle('save',async ({relative,text,original}) => { if(typeof text !== 'string' || text.length > 2e6) throw Error('Invalid file content'); const file = await localFile(relative); if(await fs.readFile(file,'utf8') !== original) throw Error('This file changed on disk. Reopen it before saving.'); await fs.writeFile(file,text); return true; });
  handle('browser-bounds',box=>{const [w,h]=win.getContentSize();if(!box || !['x','y','width','height'].every(k=>Number.isFinite(box[k])))throw Error('Invalid view bounds');const x=Math.max(0,Math.min(w,Math.round(box.x))),y=Math.max(0,Math.min(h,Math.round(box.y)));browserBounds={x,y,width:Math.max(0,Math.min(w-x,Math.round(box.width))),height:Math.max(0,Math.min(h-y,Math.round(box.height)))};bounds();});
  handle('resolve-note',async ({target,from})=>{if(typeof target!=='string' || target.length>1000)throw Error('Invalid note link');const name=/\.md$/i.test(target)?target:target+'.md';for(const candidate of [path.join(path.dirname(from || ''),name),name]){try{const file=await localFile(candidate);if((await fs.stat(file)).isFile())return path.relative(root,file);}catch{}}let count=0;async function search(dir=''){if(++count>2000)return null;for(const item of await files(dir)){if(item.folder){const found=await search(item.path);if(found)return found;}else if(item.name.toLowerCase()===path.basename(name).toLowerCase())return item.path;}return null;}const found=await search();if(!found)throw Error('Note not found: '+target);return found;});
  handle('browse',browse);
  handle('hide-browser',() => showBrowser(false));
  handle('show-browser',() => showBrowser(true));
  handle('set-service-profile',async ({key,profile})=>{if(!PROFILES.has(profile))throw Error('Invalid browser profile');let found=false;config.services=(config.services || []).map(item=>{if((item.id || item.url)!==key)return item;found=true;return {...item,profile};});if(!found)throw Error('App not found');closeServiceViews(key);await persist();return config.services;});
  handle('isolate-all-services',async()=>{for(const item of config.services || [])if(item.url)closeServiceViews(item.id || item.url);config.services=(config.services || []).map(item=>item.url?{...item,profile:'isolated'}:item);await persist();return config.services;});
  handle('clear-profile-data',async ({profile,key})=>{if(!PROFILES.has(profile))throw Error('Invalid browser profile');if(profile==='isolated' && !(config.services || []).some(item=>(item.id || item.url)===key))throw Error('App not found');for(const item of config.services || [])if(item.url && (item.profile || 'isolated')===profile && (profile!=='isolated' || (item.id || item.url)===key))closeServiceViews(item.id || item.url);await clearSessionData(session.fromPartition(partitionFor(profile,key)));return true;});
  handle('clear-claude-history',async()=>{if(chat.state.busy)throw Error('Stop Claude before clearing history');config.chats={};chat.restore(null);chat.publish();await persist();return true;});
  handle('erase-hearth-data',async()=>{if(chat.state.busy || terminal)throw Error('Stop Claude before erasing Just Zen data');const partitions=new Set([partitionFor('shared'),partitionFor('personal'),partitionFor('work')]);for(const item of config.services || [])if(item.url)partitions.add(partitionFor(item.profile || 'isolated',item.id || item.url));for(const name of partitions)await clearSessionData(session.fromPartition(name));for(const [key,view] of browsers)if(key.startsWith('url:')){if(browser===view){browser=null;browserVisible=false;}view.webContents.close();browsers.delete(key);}config={theme:config.theme || 'light'};root=null;claudeRoot=null;chat.restore(null);chat.publish();await fs.rm(path.join(app.getPath('userData'),'favicons'),{recursive:true,force:true});await fs.rm(path.join(app.getPath('userData'),'claude-sandbox'),{recursive:true,force:true});await fs.rm(claudeConfigDir,{recursive:true,force:true});
  // Remove on-disk partitions left by earlier builds that persisted ad-hoc addresses.
  const known=new Set([...partitions].map(name=>name.replace(/^persist:/,'')));const partitionRoot=path.join(app.getPath('userData'),'Partitions');for(const entry of await fs.readdir(partitionRoot,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory() && !known.has(decodeURIComponent(entry.name)))await fs.rm(path.join(partitionRoot,entry.name),{recursive:true,force:true});
  await persist();send('data-erased',true);return stateSnapshot();});
  handle('reorder-services',async keys=>{config.services=reorder(config.services || [],keys);await persist();return config.services;});
  handle('create-service-folder',async name=>{config.serviceFolders=createFolder(config.serviceFolders || [],name,require('node:crypto').randomUUID());await persist();return {services:config.services || [],folders:config.serviceFolders};});
  handle('set-service-folder',async ({key,folderId})=>{config.services=setFolder(config.services || [],key,folderId,config.serviceFolders || []);await persist();return {services:config.services,folders:config.serviceFolders || []};});
  handle('toggle-service-folder',async id=>{let found=false;config.serviceFolders=(config.serviceFolders || []).map(folder=>{if(folder.id!==id)return folder;found=true;return {...folder,collapsed:!folder.collapsed};});if(!found)throw Error('Folder not found');await persist();return {services:config.services || [],folders:config.serviceFolders};});
  handle('add-todo',async text=>{if(typeof text!=='string' || !text.trim())throw Error('Enter a task');config.todos=config.todos || [];config.todos.push({id:require('node:crypto').randomUUID(),text:text.trim().slice(0,300),done:false,createdAt:Date.now()});await persist();return config.todos;});
  handle('toggle-todo',async id=>{let found=false;config.todos=(config.todos || []).map(todo=>{if(todo.id!==id)return todo;found=true;const done=!todo.done;return {...todo,done,doneAt:done?Date.now():null};});if(!found)throw Error('Task not found');await persist();return config.todos;});
  handle('save-whiteboard',async value=>{config.whiteboard=validWhiteboard(value);await persist();return true;});
  handle('favicon',async key=>{const item=(config.services || []).find(s=>(s.id || s.url)===key);const local=bundledIcon(item);if(local)return 'data:image/png;base64,'+(await fs.readFile(path.join(__dirname,local))).toString('base64');return item?.url?favicon(item.url):null;});
  handle('web-apps',()=>catalogue.map(item=>({...item,added:isAdded(config.services || [],item)})));
  handle('add-catalog-app',async id=>{config.services=addApp(config.services || [],id);await persist();return config.services;});
  handle('remove-service',async key=>{closeServiceViews(key);config.services=(config.services || []).filter(s=>(s.id || s.url)!==key);await persist();return config.services;});
  handle('add-service',async ({name,url}) => { url = validURL(url); if(typeof name !== 'string' || !name.trim()) throw Error('Name is required'); config.services=config.services || [];if(!config.services.some(s=>s.url===url))config.services.push({id:require('node:crypto').randomUUID(),name:name.trim().slice(0,50),kind:'web',url,profile:'isolated'}); await persist(); return config.services; });
  handle('start-terminal',kind => { if(!['claude','shell'].includes(kind)) throw Error('Invalid session'); return startTerminal(kind); });
  handle('stop-terminal',() => { terminal?.kill(); });
  handle('terminal-input',data => { if(typeof data === 'string' && data.length < 100000) terminal?.write(data); });
  handle('terminal-size',({cols,rows}) => { if(Number.isInteger(cols) && Number.isInteger(rows) && cols>0 && rows>0 && cols<1000 && rows<1000) terminal?.resize(cols,rows); });
  await win.loadFile('index.html');
  if(locked)await win.webContents.executeJavaScript("document.body.classList.add('is-locked');document.getElementById('lock-screen').classList.remove('hidden')");
  win.show();
  if(!locked)scheduleLock();
  startAutoUpdates(message=>send('notice',message));
  if(!smoke){let index=0;const warm=()=>{if(!win || win.isDestroyed())return;const sites=(config.services || []).filter(s=>s.url);if(index>=sites.length)return;if(!locked){const item=sites[index++];browse({url:item.url,serviceKey:item.id || item.url,background:true}).catch(()=>{});}setTimeout(warm,1500);};setTimeout(warm,1500);}
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
      config.services=[{id:'badge-smoke',name:'Unread badge test',url:'https://example.com'}];
      updateServiceBadge('badge-smoke',unreadCount('Inbox (23) - Gmail'));
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
      await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100 && !document.querySelector('[data-badge-key="badge-smoke"]');i++)await new Promise(r=>setTimeout(r,50));const badge=document.querySelector('[data-badge-key="badge-smoke"]');if(!badge || badge.hidden || badge.textContent!=='23' || getComputedStyle(badge).display==='none')throw Error('Sidebar unread badge missing');})()`);
      updateServiceBadge('badge-smoke',0);
      await win.webContents.executeJavaScript(`(async()=>{await new Promise(r=>setTimeout(r,100));if(!document.querySelector('[data-badge-key="badge-smoke"]').hidden)throw Error('Read badge not cleared');})()`);
      const connectedBefore=root;const nextFolder=path.join(root,'second-folder');await fs.mkdir(nextFolder,{recursive:true});config.connectedFolders=[connectedBefore,nextFolder];
      await win.webContents.executeJavaScript(`(async()=>{const state=await window.hearth.call('select-files-folder',${JSON.stringify(nextFolder)});if(state.root!==state.claudeRoot || !state.connectedFolders.includes(${JSON.stringify(connectedBefore)}))throw Error('Folder switch lost history or left Claude stale');})()`);
      const pdfTest=await require('pdf-lib').PDFDocument.create();pdfTest.addPage([200,200]);const {PDFName,PDFString}=require('pdf-lib');pdfTest.catalog.set(PDFName.of('OpenAction'),pdfTest.context.obj({S:'JavaScript',JS:PDFString.of('globalThis.__pdfAttack=1')}));
      const pdfBytes=Buffer.from(await pdfTest.save()).toString('base64');
      await win.webContents.executeJavaScript(`document.getElementById('documents-rail').click()`);
      await dc.executeJavaScript(`(async()=>{if(window.hearth || typeof require!=='undefined')throw Error('Document viewer has privileged app access');let denied=false;try{window.documents.call('start-terminal','shell');}catch{denied=true;}if(!denied)throw Error('Document bridge accepted terminal action');let networkBlocked=false;try{await fetch('https://example.com');}catch{networkBlocked=true;}if(!networkBlocked)throw Error('Document viewer network access enabled');const lib=await import('./node_modules/pdfjs-dist/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('./node_modules/pdfjs-dist/build/pdf.worker.mjs',location.href).href;const loading=lib.getDocument({data:Uint8Array.from(atob('${pdfBytes}'),c=>c.charCodeAt(0)),isEvalSupported:false});const pdf=await loading.promise;const page=await pdf.getPage(1);const canvas=document.getElementById('pdf-canvas');await page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale:1})}).promise;await loading.destroy();if(globalThis.__pdfAttack)throw Error('PDF script executed');})()`);
      await require('./smoke-adversarial.cjs')({documentContents:dc});
      startTerminal('shell');
      await new Promise((resolve,reject) => {const timer=setTimeout(()=>reject(Error('PTY timed out')),5000); let output=''; terminal.onData(d=>{output+=d;if(output.includes('HEARTH_PTY_OK')){clearTimeout(timer);resolve();}}); terminal.write("printf 'HEARTH_%s_OK\\n' PTY\r");});
      terminal.kill();
      await fs.writeFile(path.join(__dirname,'smoke.png'),(await win.webContents.capturePage()).toPNG());
      console.log('SMOKE PASS: renderer, bridge, vault, path containment, real PTY'); app.quit();
    } catch(e) {console.error(e);app.exit(1);}
  }
});
app.on('window-all-closed',() => app.quit());
