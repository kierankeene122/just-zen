const SHARED_PARTITION='persist:services';
// The pinned Browser app keeps its own persistent profile, separate from every saved app, and can be cleared from Privacy & data.
const BROWSER_PARTITION='persist:browser';
const PROFILES=new Set(['shared','personal','work','isolated']);
function partitionFor(profile='isolated',key=''){
 if(!PROFILES.has(profile))throw Error('Invalid browser profile');
 if(profile==='shared')return SHARED_PARTITION;
 if(profile==='isolated')return 'persist:isolated-'+require('node:crypto').createHash('sha256').update(String(key)).digest('hex').slice(0,24);
 return 'persist:profile-'+profile;
}
function webPreferences(profile='isolated',key=''){return {partition:partitionFor(profile,key),sandbox:true,contextIsolation:true,nodeIntegration:false,navigateOnDragDrop:false};}
function browserWebPreferences(){return {...webPreferences(),partition:BROWSER_PARTITION};}
// Addresses opened ad hoc (URL bar, links in notes or chat) get an in-memory partition that dies with the view,
// so no cookies for unsaved sites are left on disk.
function ephemeralPartition(key=''){return 'ephemeral-'+require('node:crypto').createHash('sha256').update(String(key)).digest('hex').slice(0,24);}
function ephemeralWebPreferences(key=''){return {...webPreferences(),partition:ephemeralPartition(key)};}
function sharedWebPreferences(){return webPreferences('shared');}
function permitted(url){try{return ['https:','http:'].includes(new URL(url).protocol);}catch{return false;}}
// Translate app launch links only where there is a known web equivalent.
function webEquivalent(value){
 try{
  const u=new URL(value);
  if(u.protocol==='slack:'){
   const team=u.searchParams.get('team'),channel=u.searchParams.get('id');
   if(team && /^[A-Z0-9]+$/i.test(team))return 'https://app.slack.com/client/'+team+(channel && /^[A-Z0-9]+$/i.test(channel)?'/'+channel:'');
   return 'https://app.slack.com/';
  }
  if(u.protocol==='notion:')return 'https://www.notion.so'+u.pathname+u.search+u.hash;
  if(u.protocol==='msteams:' && /(^|\.)teams\.microsoft\.com$/.test(u.hostname))return 'https://'+u.host+u.pathname+u.search+u.hash;
 }catch{}
 return null;
}
function slackWebURL(value){
 try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol) || !(u.hostname==='slack.com' || u.hostname.endsWith('.slack.com')))return null;
 if(u.pathname==='/ssb/redirect' || u.pathname.startsWith('/ssb/redirect/')){u.pathname='/messages';u.search='';u.hash='';}
 return u.href;}catch{return null;}
}
// createTab, when given, receives Electron's window options for a permitted popup and returns the WebContents that should
// host it (a tab in the same pane); the opener relationship is kept so OAuth popups can still talk back and close themselves.
function configureWebContents(contents,parent,notify=()=>{},rootContents=contents,preferences=sharedWebPreferences(),createTab=null){
 let pending=null,lastLaunch=null;
 function openInRoot(target){
  if(pending===target || rootContents.getURL?.()===target)return;
  pending=target;
  queueMicrotask(()=>{if(!rootContents.isDestroyed?.())rootContents.loadURL(target).catch(()=>notify('Could not open the web version.')).finally(()=>{pending=null;});else pending=null;});
 }
 function keepInside(value){
  const target=webEquivalent(value);
  if(target){
   // Slack can repeatedly request its native app even from a working web client.
   if(lastLaunch===target || (value.startsWith('slack:') && /^https:\/\/app\.slack\.com\/client(?:\/|$)/.test(rootContents.getURL?.() || '')))return;
   lastLaunch=target;openInRoot(target);
  }else notify('This link tries to open a desktop app. Use the site’s web version to stay in Just Zen.');
 }
 function navigation(event,legacyURL){
  const url=event.url || legacyURL;
  const slack=slackWebURL(url);
  if(slack && slack!==url){event.preventDefault();openInRoot(slack);return;}
  if(permitted(url) || url==='about:blank')return;
  event.preventDefault();
  if(url && !/^(about:|data:|blob:)/i.test(url))keepInside(url);
 }
 // App-launch links can originate in hidden frames as well as the main page.
 for(const event of ['will-navigate','will-frame-navigate','will-redirect'])contents.on(event,navigation);
 // Child windows remain Hearth-owned; retaining opener is necessary for OAuth.
 contents.setWindowOpenHandler(({url})=>{
  const slack=slackWebURL(url);
  if(slack){openInRoot(slack);return {action:'deny'};}
  if(!permitted(url) && url!=='about:blank'){keepInside(url);return {action:'deny'};}
  if(createTab)return {action:'allow',overrideBrowserWindowOptions:{webPreferences:preferences},createWindow:options=>createTab({...options,webPreferences:{...(options.webPreferences || {}),...preferences}})};
  return {action:'allow',overrideBrowserWindowOptions:{parent,width:1000,height:780,autoHideMenuBar:true,webPreferences:preferences}};
 });
 contents.on('did-create-window',child=>configureWebContents(child.webContents,parent,notify,rootContents,preferences));
}
module.exports={SHARED_PARTITION,BROWSER_PARTITION,browserWebPreferences,PROFILES,partitionFor,webPreferences,ephemeralPartition,ephemeralWebPreferences,sharedWebPreferences,configureWebContents,webEquivalent,slackWebURL};
