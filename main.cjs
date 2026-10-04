const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme, net, nativeImage, safeStorage, systemPreferences, session, Notification, webContents, clipboard, shell, desktopCapturer, globalShortcut, Tray, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const crypto=require('node:crypto');
const {catalogue,findApp,isAdded,addApp,bundledIcon} = require('./app-catalog.cjs');
const {createFaviconCache}=require('./favicons.cjs');
const {startAutoUpdates}=require('./auto-update.cjs');
const nativeApps=require('./native.cjs');
const {seedPins}=require('./panel-seed.cjs');
const {createSecureStore}=require('./secure-store.cjs');
const {createImageDecoder}=require('./image-decoder.cjs');
let favicon;
// Every open web page is a WebContentsView keyed by app and tab; the renderer says which ones are on screen and where.
const BROWSER_KEY='browser';
const SLEEP_CHOICES=new Set([0,5,15,30,60,120]);
const { pathToFileURL } = require('node:url');
let flickWindow=null,pillWindow=null,tray=null,trayRefresh=()=>{},flickReady=false,pendingFlickMode='';
let updateReady='',checkUpdates=()=>{},installUpdate=()=>{};
function applyMenuBarOnly(){if(process.platform!=='darwin')return;try{if(config.menuBarOnly===true)app.dock?.hide();else app.dock?.show();}catch{}}
let config = {}, secureStore;
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
// Anything hidden — another workspace, another pane, a background tab — is closed after a while and reloads when you go back.
const SLEEP_DEFAULT=30;
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
async function flickResults(query,stage,mode='open'){
  const needle=String(query || '').trim().toLowerCase();
  const out=[];
  if(stage==='fast'){
    const apps=await nativeApps.listApps();
    for(const item of apps){const s=score(item.label,needle);if(s)out.push({...item,group:'Apps',hint:'open',score:s});}
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
// The finder and the panel are the only pages Just Zen has; a channel is answered for them and nobody else.
function handlePanel(name,fn,getters=[()=>flickWindow,()=>pillWindow]){
  ipcMain.handle(name,async (e,...args)=>{
    const ours=getters.some(get=>{const w=get();return w && !w.isDestroyed() && e.sender===w.webContents && e.senderFrame===w.webContents.mainFrame;});
    if(!ours)throw Error('Untrusted request');
    return fn(...args);
  });
}
function handle(name,fn){handlePanel(name,fn);}
function send(){}
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
function pinList(){
  return (Array.isArray(config.pins)?config.pins:[]).slice(0,40).map(pin=>({iconCustom:pin.iconCustom===true,id:String(pin.id || '').slice(0,2000),kind:pin.kind,label:String(pin.label || '').slice(0,80),detail:String(pin.detail || '').slice(0,120),target:pin.target,icon:pin.icon || '',glyph:pin.glyph || '',folder:String(pin.folder || '').slice(0,40),iconFile:pin.iconFile || ''}));
}
async function sendPins(){
  if(!pillWindow || pillWindow.isDestroyed())return;
  const pins=pinList();
  for(const pin of pins){if(pin.icon || pin.iconCustom)continue;if(pin.iconFile)pin.icon=await catalogueIcon(pin.iconFile);else if(pin.kind==='web' && typeof pin.target==='string'){try{pin.icon=await favicon(pin.target) || '';}catch{}}else if(typeof pin.target==='string' && (pin.kind==='app' || pin.kind==='file'))pin.icon=await appIcon(pin.target);}
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
}
function askFolder(pinId){
  if(pillWindow && !pillWindow.isDestroyed()){pillWindow.webContents.send('pill-ask-group',{id:pinId});pillWindow.focus();}
}
// Choosing a picture for a pin, for the places a favicon does not do justice to.
async function chooseIcon(pinId){
  const pin=(config.pins || []).find(p=>p.id===pinId);
  if(!pin)return;
  const forced=!app.isPackaged?process.env.HEARTH_TEST_ICON:'';
  const choice=forced?{canceled:false,filePaths:[forced]}:await dialog.showOpenDialog(pillWindow || undefined,{
    title:'Choose an icon for '+pin.label,
    properties:['openFile'],
    filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','tiff','tif','heic','gif','bmp','icns']}]
  });
  const file=choice.canceled?'':choice.filePaths?.[0];
  if(!file)return;
  try{
    const png=await nativeApps.imageAsPng(file,path.join(app.getPath('userData'),'app-icons'));
    const image=nativeImage.createFromPath(png || file);
    if(image.isEmpty())throw Error('That file is not an image Just Zen can read.');
    pin.icon=image.resize({width:72,height:72}).toDataURL();
    pin.iconCustom=true;
    await persist();sendPins();
  }catch(error){notifyPanel(error.message);}
}
function clearIcon(pinId){
  const pin=(config.pins || []).find(p=>p.id===pinId);
  if(!pin)return;
  delete pin.iconCustom;pin.icon='';
  persistSoon();sendPins();
}
async function openPin(id){
  const pin=pinList().find(p=>p.id===id);
  if(!pin)return;
  flickIndex.set(pin.id,pin);
  try{await openFlick(pin.id);}catch(error){notifyPanel(error.message);}
}
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
// A popup (window.open, target=_blank, OAuth) becomes a new tab in the same pane; Chromium loads it and keeps the opener.
// Peek: a link opened from an app slides out in a drawer over the right of the centre instead of taking the whole pane.
// Esc dismisses it; it can be promoted to a tab, or opened beside. Popups and Shift+Space on a hovered link both land here.
const AUTH_HOSTS=/(^|\.)(accounts\.google\.com|accounts\.youtube\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|id\.atlassian\.com|login\.yahoo\.com|okta\.com|auth0\.com|login\.salesforce\.com|auth\.atlassian\.com|signin\.aws\.amazon\.com)$/i;

// Quiet chrome: a pane's buttons are placed all the time but only shown when they are wanted —
// while the pointer is near the top of that pane, while the pointer is on the buttons themselves,
// or while ⌘ is held. Until search has been used a few times they simply stay visible.
function notifyPanel(message){try{if(Notification.isSupported())new Notification({title:'Just Zen',body:String(message || '').slice(0,160)}).show();}catch{}}
function retintChrome(){const theme=config.theme==='dark'?'dark':'light';for(const w of [flickWindow,pillWindow])if(w && !w.isDestroyed())w.webContents.send(w===flickWindow?'flick-theme':'pill-theme',theme);}
// An app can opt into the mobile web when its pane is thin (phone user agent and viewport); by default a narrow pane is just the site in a smaller window.
const MOBILE_WIDTH=480;
// A page that is a live call: Meet rooms, Teams meeting joins, Zoom meetings.
const MOBILE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Dark mode for websites: when the app is dark, pages that stay light are inverted (images and video inverted back). Nothing is touched in light mode.
const DARK_CSS='html{filter:invert(1) hue-rotate(180deg)!important;background:#111!important}img,video,canvas,picture,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}';
function retheme(){retintChrome();}
// Claude runs inside an operating-system sandbox, which this app only provides on macOS. Elsewhere it stays off rather than run unsandboxed.
const CLAUDE_SUPPORTED=process.platform==='darwin';
const CLAUDE_UNAVAILABLE='Claude is not available on Windows yet: it runs inside a macOS sandbox, and Just Zen will not run it without one.';
// A failure during startup must never leave a running process with no window: say what went wrong and stop.
function startupFailed(error){
  const detail=String(error && error.stack || error);
  try{require('node:fs').appendFileSync(path.join(app.getPath('userData'),'startup-error.log'),new Date().toISOString()+' '+detail+'\n');}catch{}
  try{dialog.showErrorBox('Just Zen could not start',detail.slice(0,2000));}catch{}
  app.exit(1);
}
process.on('uncaughtException',error=>{if(!app.isReady())startupFailed(error);else console.error(error);});
app.whenReady().then(async () => {
  secureStore=createSecureStore({fs,safeStorage,userData:app.getPath('userData')});
  try{config=await secureStore.load();}catch(error){console.error(error);config={};}
  if(config.startMode===undefined)config.startMode='panel';
  config.pins=(Array.isArray(config.pins)?config.pins:[]).map(pin=>{
    if(pin.kind!=='pane')return pin;
    const item=(config.services || []).find(s=>(s.id || s.url)===String(pin.id || '').slice(5));
    return item?.url?{...pin,kind:'web',id:'web:'+item.url,target:item.url,detail:hostOf(item.url),glyph:'◐'}:null;
  }).filter(Boolean);
  {const seeded=seedPins({pins:config.pins,services:config.services,seeded:config.pinsSeeded===true});if(seeded.changed){config.pins=seeded.pins;config.pinsSeeded=true;persistSoon();}}
  if(config.pillOn===undefined)config.pillOn=true;
  if(config.menuBarOnly===undefined)config.menuBarOnly=process.platform==='darwin';
  favicon=createFaviconCache(path.join(app.getPath('userData'),'favicons'),net,createImageDecoder({BrowserWindow}));
  nativeTheme.themeSource=config.theme || 'light';
  // Just Zen has no window of its own: a menu-bar item, a panel, and a finder summoned with a key.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Just Zen',submenu:[
      {role:'about'},{type:'separator'},
      {label:'Find anything…',accelerator:'Alt+Space',click:()=>toggleFlick()},
      {label:'Add to the panel…',accelerator:'Alt+Shift+A',click:()=>toggleFlick('pin')},
      {label:'Show the panel',type:'checkbox',checked:config.pillOn===true,click:item=>setPill(item.checked)},
      {type:'separator'},{role:'quit'}
    ]},
    {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]}
  ]));
  handle('flick-list',async ({query}={})=>{const items=await flickResults(query,'fast');const docs=await flickResults(query,'slow');const all=[...items,...docs].filter(i=>['app','file','url'].includes(i.kind));for(const item of all)flickIndex.set(item.id,item);return all.slice(0,12).map(({score,...rest})=>rest);});

  handlePanel('flick-search',async ({query,stage,mode}={})=>{
    const items=await flickResults(query,stage,mode==='pin'?'pin':'open');
    for(const item of items)flickIndex.set(item.id,item);
    if(flickIndex.size>600)flickIndex.clear();
    return items.map(({score,...rest})=>rest);
  },[()=>flickWindow]);

  handlePanel('flick-open',async ({id,pin}={})=>{
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

  ipcMain.on('pill-order',(e,ids)=>{
    if(!fromPill(e))return;
    const byId=new Map((config.pins || []).map(p=>[p.id,p]));
    const next=[];
    for(const id of (Array.isArray(ids)?ids:[]).slice(0,40))if(byId.has(id)){next.push(byId.get(id));byId.delete(id);}
    for(const rest of byId.values())next.push(rest);
    config.pins=next;persistSoon();sendPins();
  });

  ipcMain.on('pill-group',(e,{id,folder}={})=>{
    if(!fromPill(e))return;
    const pin=(config.pins || []).find(p=>p.id===String(id || ''));
    if(!pin)return;
    pin.folder=String(folder || '').trim().slice(0,40);
    persistSoon();sendPins();
  });

  ipcMain.on('pill-menu',(e,id)=>{
    if(!fromPill(e))return;
    const pin=pinList().find(p=>p.id===String(id || ''));
    if(!pin){
      // Right-clicking the panel itself: everything you can do to the panel as a whole.
      const groups=[...new Set(pinList().map(p=>p.folder).filter(Boolean))];
      Menu.buildFromTemplate([
        {label:'Add an app…',click:()=>toggleFlick('pin')},
        {label:'New group…',enabled:pinList().length>0,click:()=>askFolder(pinList()[0]?.id)},
        ...(groups.length?[{label:'Groups',submenu:groups.map(name=>({label:name,enabled:false}))}]:[]),
        {label:'Drag one icon onto another to group them',enabled:false},
        {type:'separator'},
        {label:'Find anything…',click:()=>toggleFlick()},
        {label:'Hide the panel',click:()=>setPill(false)}
      ]).popup({window:pillWindow});
      return;
    }
    const folders=[...new Set(pinList().map(p=>p.folder).filter(Boolean))];
    Menu.buildFromTemplate([
      {label:'Open '+pin.label,click:()=>openPin(pin.id).catch(()=>{})},
      {type:'separator'},
      {label:'Group',submenu:[
        ...folders.map(name=>({label:name,type:'radio',checked:pin.folder===name,click:()=>{const p=(config.pins || []).find(x=>x.id===pin.id);if(p){p.folder=name;persistSoon();sendPins();}}})),
        ...(folders.length?[{type:'separator'}]:[]),
        {label:'New group…',click:()=>askFolder(pin.id)},
        {label:'Tip: drag one icon onto another',enabled:false},
        ...(pin.folder?[{label:'Out of '+pin.folder,click:()=>{const p=(config.pins || []).find(x=>x.id===pin.id);if(p){p.folder='';persistSoon();sendPins();}}}]:[])
      ]},
      {label:'Choose an icon…',click:()=>chooseIcon(pin.id)},
      ...(pin.iconCustom?[{label:'Use the usual icon',click:()=>clearIcon(pin.id)}]:[]),
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
    }catch(error){notifyPanel(error.message);}
  });

  handle('install-update',()=>{if(!updates.install)throw Error('No update is ready');updates.install();return true;});

  handle('check-updates',()=>{if(!updates.checkNow)throw Error(updates.reason==='development'?'Update checks are off in a development build.':'Updates are not available in this build.');updates.checkNow();return true;});

  try{
    const trayIcon=nativeImage.createFromPath(path.join(__dirname,'assets','justzen.png')).resize({width:18,height:18});
    trayIcon.setTemplateImage?.(process.platform==='darwin');
    tray=new Tray(trayIcon);
    tray.setToolTip('Just Zen');
    const buildTrayMenu=()=>Menu.buildFromTemplate([
      {label:'Find anything…',accelerator:'Alt+Space',click:()=>toggleFlick()},
      {label:'Add to the panel…',click:()=>toggleFlick('pin')},
      {type:'separator'},
      {label:'Show the panel',type:'checkbox',checked:config.pillOn===true,click:item=>setPill(item.checked)},
      {label:updateReady?('Restart to update to '+updateReady):'Check for updates…',click:()=>{if(updateReady)installUpdate();else checkUpdates();}},
      {label:'Settings',submenu:[
        {label:'Menu bar only (no Dock icon)',type:'checkbox',checked:config.menuBarOnly===true,click:item=>{config.menuBarOnly=item.checked;applyMenuBarOnly();persistSoon();}},
        {label:'Reuse an open browser tab',type:'checkbox',checked:config.safariTabs!==false,click:item=>{config.safariTabs=item.checked;persistSoon();trayRefresh();}},
        {label:'Land inside the app (Claude, Gemini, Slack)',type:'checkbox',checked:config.deepLinks!==false,click:item=>{config.deepLinks=item.checked;persistSoon();trayRefresh();}},
      ]},
      {type:'separator'},
      {label:'Quit Just Zen',click:()=>{quitting=true;app.quit();}}
    ]);
    tray.on('click',()=>{if(process.platform==='win32')toggleFlick();else tray.popUpContextMenu(buildTrayMenu());});
    tray.on('right-click',()=>tray.popUpContextMenu(buildTrayMenu()));
    tray.setContextMenu(buildTrayMenu());
    trayRefresh=()=>{try{tray.setContextMenu(buildTrayMenu());}catch{}};
  }catch(error){console.warn('Tray unavailable:',error.message);}
  applyMenuBarOnly();
  setPill(config.pillOn!==false);
  ensureFlick();
  for(const [accel,run] of [['Alt+Space',()=>toggleFlick()],['Alt+Shift+A',()=>toggleFlick('pin')]]){
    try{globalShortcut.register(accel,run);}catch{}
  }

  // Updates have nowhere to appear but the menu bar and a notification, so that is where they go.
  function notify(title,body){try{if(Notification.isSupported())new Notification({title,body:String(body || '').slice(0,200)}).show();}catch{}}
  const updates=startAutoUpdates(
    message=>{if(!/No update|up to date|Checking/i.test(message))notify('Just Zen',message);},
    version=>{updateReady=String(version || '');trayRefresh();notify('Just Zen '+updateReady+' is ready','Choose it in the menu bar to restart and update.');}
  );
  checkUpdates=()=>{try{updates.checkNow?.();notify('Just Zen','Looking for a new version…');}catch(error){notify('Just Zen',error.message);}};
  installUpdate=()=>{try{updates.install?.();}catch(error){notify('Just Zen',error.message);}};
  if(smoke){
    try{
      for(const item of require('./app-catalog.cjs').catalogue){if(nativeImage.createFromPath(path.join(__dirname,item.icon)).isEmpty())throw Error('Invalid bundled icon: '+item.name);}
      // The finder reaches real things: an installed app, the web library, and an address typed by hand.
      const apps=await flickResults('safari','fast');
      if(!apps.some(item=>item.kind==='app'))throw Error('No applications found');
      const web=await flickResults('gmail','fast');
      if(!web.some(item=>item.kind==='web'))throw Error('Web app library missing');
      const typed=webFromQuery('example.com');
      if(!typed || typed.target!=='https://example.com/')throw Error('Typed address not understood');
      if(webFromQuery('not an address'))throw Error('Nonsense accepted as an address');
      // A picture chosen by hand becomes that pin's icon, and the usual one can be put back.
      addPin({id:'web:https://icon.example/',kind:'web',label:'Icon test',target:'https://icon.example/'});
      process.env.HEARTH_TEST_ICON=path.join(__dirname,'assets','justzen.png');
      await chooseIcon('web:https://icon.example/');
      const iconPin=(config.pins || []).find(p=>p.id==='web:https://icon.example/');
      if(!iconPin?.icon?.startsWith('data:image/png;base64,'))throw Error('Chosen icon not kept');
      if(iconPin.iconCustom!==true)throw Error('Chosen icon not marked as the user\'s');
      clearIcon('web:https://icon.example/');
      if((config.pins || []).find(p=>p.id==='web:https://icon.example/')?.icon)throw Error('Icon not cleared');
      config.pins=[];
      // The panel keeps what it is given, once, and gives it back in the order it is put in.
      addPin({id:'web:https://example.com/',kind:'web',label:'Example',target:'https://example.com/'});
      addPin({id:'web:https://example.org/',kind:'web',label:'Example org',target:'https://example.org/'});
      addPin({id:'web:https://example.com/',kind:'web',label:'Example',target:'https://example.com/'});
      if(pinList().length!==2)throw Error('Duplicate pin accepted');
      config.pins=[config.pins[1],config.pins[0]];
      if(pinList()[0].label!=='Example org')throw Error('Panel order not kept');
      config.pins=[];
      // The windows that make up the app are there and fenced to their own files.
      if(!pillWindow || pillWindow.isDestroyed())throw Error('The panel is missing');
      if(!flickWindow || flickWindow.isDestroyed())throw Error('The finder is missing');
      await new Promise(resolve=>{if(!flickWindow.webContents.isLoading())return resolve();flickWindow.webContents.once('did-finish-load',resolve);});
      const bridged=await flickWindow.webContents.executeJavaScript('Boolean(window.flick && window.flick.search) && !window.require && !window.hearth');
      if(!bridged)throw Error('The finder bridge is wrong');
      await require('./smoke-adversarial.cjs')({});
      console.log('SMOKE PASS: config, finder, panel, order, icons, windows, bridges');
      app.quit();
    }catch(error){console.error(error);app.exit(1);}
  }
}).catch(startupFailed);
let quitting=false;
app.on('window-all-closed',()=>{if(config.pillOn===true || config.menuBarOnly===true)return;quitting=true;app.quit();setTimeout(()=>app.exit(0),2500);});
app.on('before-quit',()=>{quitting=true;try{globalShortcut.unregisterAll();}catch{}setTimeout(()=>app.exit(0),4000);});
// Dock click with no window left (a quit that stalled): start over rather than sit there.
// Clicking the icon brings the panel forward; there is no window to conjure.
app.on('activate',()=>{if(pillWindow && !pillWindow.isDestroyed())pillWindow.showInactive();else setPill(true);});
