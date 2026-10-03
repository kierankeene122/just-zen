// Reaching what is already on the machine: the apps you have installed, the documents Spotlight knows about,
// and the deep links that land inside an app rather than merely in front of it.
// Nothing here runs a shell: every call is execFile with a fixed argument list.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const crypto=require('node:crypto');

const MAC=process.platform==='darwin';
const WIN=process.platform==='win32';
const APP_DIRS=MAC
  ? ['/Applications','/Applications/Utilities','/System/Applications',path.join(os.homedir(),'Applications'),path.join(os.homedir(),'Applications','Chrome Apps.localized')]
  : WIN
    ? [path.join(process.env.ProgramData || 'C:\\ProgramData','Microsoft','Windows','Start Menu','Programs'),path.join(process.env.APPDATA || '','Microsoft','Windows','Start Menu','Programs')]
    : [];
const APP_EXT=MAC?'.app':'.lnk';
// Documents worth offering: the formats the user actually opens, not every file on the disk.
const DOC_TYPES=['org.openxmlformats.spreadsheetml.sheet','org.openxmlformats.wordprocessingml.document','org.openxmlformats.presentationml.presentation','com.microsoft.excel.xls','com.microsoft.word.doc','com.microsoft.powerpoint.ppt','com.adobe.pdf','com.apple.iwork.pages.sffpages','com.apple.iwork.numbers.sffnumbers','com.apple.iwork.keynote.sffkey','net.daringfireball.markdown','public.plain-text','public.comma-separated-values-text'];

function run(file,args,{timeout=6000}={}){
  return new Promise((resolve,reject)=>{
    execFile(file,args,{timeout,maxBuffer:4*1024*1024,windowsHide:true},(error,stdout)=>error?reject(error):resolve(String(stdout)));
  });
}

// ---- applications -------------------------------------------------------
let appCache={at:0,items:[]};
async function listApps({refresh=false}={}){
  if(!refresh && appCache.items.length && Date.now()-appCache.at<10*60_000)return appCache.items;
  const seen=new Map();
  for(const dir of APP_DIRS){
    let entries=[];try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{continue;}
    for(const entry of entries){
      if(!entry.name.endsWith(APP_EXT))continue;
      const full=path.join(dir,entry.name);
      const name=entry.name.slice(0,-APP_EXT.length).replace(/\.localized$/,'');
      if(!name || seen.has(name.toLowerCase()))continue;
      seen.set(name.toLowerCase(),{kind:'app',id:'app:'+full,label:name,target:full});
    }
  }
  appCache={at:Date.now(),items:[...seen.values()].sort((a,b)=>a.label.localeCompare(b.label))};
  return appCache.items;
}

// ---- documents ----------------------------------------------------------
// Spotlight on macOS; a shallow walk of the usual folders elsewhere. Neither needs a permission prompt.
async function findDocs(query,{limit=12}={}){
  const q=String(query || '').trim();
  if(q.length<2)return [];
  if(MAC){
    const safe=q.replace(/["\\]/g,'');
    const types=DOC_TYPES.map(t=>`kMDItemContentType == "${t}"`).join(' || ');
    const expr=`(kMDItemDisplayName == "*${safe}*"cd) && (${types})`;
    let out='';try{out=await run('/usr/bin/mdfind',['-onlyin',os.homedir(),expr],{timeout:4000});}catch{return [];}
    const files=out.split('\n').map(line=>line.trim()).filter(Boolean).slice(0,limit*3);
    const stats=await Promise.all(files.map(async file=>{try{const s=await fs.stat(file);return {file,used:s.mtimeMs};}catch{return null;}}));
    return stats.filter(Boolean).sort((a,b)=>b.used-a.used).slice(0,limit)
      .map(({file})=>({kind:'file',id:'file:'+file,label:path.basename(file),detail:prettyDir(path.dirname(file)),target:file}));
  }
  const roots=[os.homedir(),path.join(os.homedir(),'Documents'),path.join(os.homedir(),'Desktop'),path.join(os.homedir(),'Downloads')];
  const needle=q.toLowerCase();const out=[];
  for(const root of roots){
    let entries=[];try{entries=await fs.readdir(root,{withFileTypes:true});}catch{continue;}
    for(const entry of entries){
      if(out.length>=limit)break;
      if(!entry.isFile() || !entry.name.toLowerCase().includes(needle))continue;
      if(!/\.(xlsx?|docx?|pptx?|pdf|csv|md|txt)$/i.test(entry.name))continue;
      const file=path.join(root,entry.name);
      out.push({kind:'file',id:'file:'+file,label:entry.name,detail:prettyDir(root),target:file});
    }
  }
  return out;
}
function prettyDir(dir){
  const home=os.homedir();
  let label=dir.startsWith(home)?'~'+dir.slice(home.length):dir;
  label=label.replace(/^~\/Library\/CloudStorage\/GoogleDrive-[^/]*/,'Google Drive').replace(/^~\/Library\/CloudStorage\/ProtonDrive-[^/]*/,'Proton Drive').replace(/^~\/Library\/CloudStorage\/OneDrive-?[^/]*/,'OneDrive');
  const parts=label.split('/').filter(Boolean);
  return parts.slice(-2).join(' / ');
}

// ---- opening ------------------------------------------------------------
function isAppPath(target){return typeof target==='string' && target.endsWith(APP_EXT);}
async function openApp(target){
  if(!isAppPath(target))throw Error('Not an application');
  if(MAC)return run('/usr/bin/open',['-a',target]);
  if(WIN)return run('cmd.exe',['/c','start','',target]);
  throw Error('Unsupported platform');
}
async function openFile(target,{withApp=''}={}){
  if(typeof target!=='string' || !target)throw Error('Nothing to open');
  await fs.access(target);
  if(MAC)return run('/usr/bin/open',withApp?['-a',withApp,target]:[target]);
  if(WIN)return run('cmd.exe',['/c','start','',target]);
  throw Error('Unsupported platform');
}

// ---- Safari tabs (asks for Automation the first time) --------------------
const SAFARI_TABS='tell application "Safari"\nset out to ""\nrepeat with w from 1 to count of windows\nrepeat with t from 1 to count of tabs of window w\nset out to out & w & "\\t" & t & "\\t" & (name of tab t of window w) & "\\t" & (URL of tab t of window w) & "\\n"\nend repeat\nend repeat\nreturn out\nend tell';
async function safariTabs(){
  if(!MAC)return [];
  let out='';
  try{out=await run('/usr/bin/osascript',['-e',SAFARI_TABS],{timeout:8000});}catch(error){throw Error(automationMessage(error));}
  return out.split('\n').map(line=>line.split('\t')).filter(parts=>parts.length>=4)
    .map(([w,t,name,url])=>({kind:'tab',id:'safari:'+w+':'+t,label:(name || url).slice(0,120),detail:hostOf(url),target:{window:Number(w),tab:Number(t)},url}));
}
async function focusSafariTab({window:w,tab:t}={}){
  if(!MAC)return false;
  const script=`tell application "Safari"\nactivate\nset current tab of window ${Number(w)} to tab ${Number(t)} of window ${Number(w)}\nset index of window ${Number(w)} to 1\nend tell`;
  try{await run('/usr/bin/osascript',['-e',script],{timeout:8000});return true;}catch(error){throw Error(automationMessage(error));}
}
// Raising another app's window needs Accessibility; activating the app itself never does.
async function raiseWindow(appName,titlePart=''){
  if(!MAC)return false;
  const name=String(appName).replace(/"/g,'');
  const part=String(titlePart).replace(/"/g,'');
  const script=part
    ? `tell application "System Events" to tell process "${name}"\nset frontmost to true\nrepeat with w in windows\nif name of w contains "${part}" then\nperform action "AXRaise" of w\nexit repeat\nend if\nend repeat\nend tell`
    : `tell application "System Events" to tell process "${name}" to set frontmost to true`;
  try{await run('/usr/bin/osascript',['-e',script],{timeout:8000});return true;}catch(error){throw Error(accessibilityMessage(error));}
}
function automationMessage(error,app='Safari'){
  const text=String(error?.stderr || error?.message || '');
  if(/not allowed|1743|-1743/.test(text))return 'macOS has not been told that Just Zen may control '+app+'. Allow it under Privacy & Security \u203a Automation, then try again.';
  return app+' did not answer: '+text.split('\n')[0].slice(0,120);
}
function accessibilityMessage(error){
  const text=String(error?.stderr || error?.message || '');
  if(/not allowed|assistive|1719|-1719/.test(text))return 'macOS needs Just Zen under Privacy & Security \u203a Accessibility before it can bring another app\u2019s window forward.';
  return 'Could not bring that window forward: '+text.split('\n')[0].slice(0,120);
}
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}}

// ---- app deep links -----------------------------------------------------
// Landing inside an app, not merely in front of it. Only schemes the machine actually registers are offered.
const DEEP_LINKS=[
  {match:/^claude$/i,scheme:'claude://'},
  {match:/^gemini$/i,scheme:'googlegemini://'},
  {match:/^chatgpt$/i,scheme:'chatgpt://'},
  {match:/^slack$/i,scheme:'slack://open'},
  {match:/^obsidian$/i,scheme:'obsidian://'}
];
function deepLinkFor(appLabel){
  const entry=DEEP_LINKS.find(d=>d.match.test(String(appLabel).trim()));
  return entry?entry.scheme:'';
}

// macOS hands out a generic icon for a bundle; the real one is inside it, named in its Info.plist.
async function appIconFile(bundle){
  if(!MAC || !isAppPath(bundle))return '';
  const plist=path.join(bundle,'Contents','Info.plist');
  let name='';
  try{name=(await run('/usr/bin/plutil',['-extract','CFBundleIconFile','raw','-o','-',plist],{timeout:3000})).trim();}catch{}
  const candidates=[];
  if(name)candidates.push(name.endsWith('.icns')?name:name+'.icns');
  candidates.push('AppIcon.icns','app.icns','icon.icns');
  for(const candidate of candidates){
    const file=path.join(bundle,'Contents','Resources',candidate);
    try{await fs.access(file);return file;}catch{}
  }
  return '';
}

// nativeImage cannot read .icns, so the icon is converted once with sips and kept as a png.
async function appIconPng(bundle,cacheDir){
  const icns=await appIconFile(bundle);
  if(!icns || !cacheDir)return '';
  const out=path.join(cacheDir,crypto.createHash('sha1').update(icns).digest('hex').slice(0,16)+'.png');
  try{await fs.access(out);return out;}catch{}
  try{await fs.mkdir(cacheDir,{recursive:true});}catch{}
  try{await run('/usr/bin/sips',['-s','format','png','-Z','72',icns,'--out',out],{timeout:8000});return out;}catch{return '';}
}

// Web apps open in whatever browser the machine calls the default one.
async function openInBrowser(url){
  if(MAC)return run('/usr/bin/open',[url]);
  if(WIN)return run('cmd.exe',['/c','start','',url]);
  throw Error('Unsupported platform');
}
// Which browser that is, read from Launch Services rather than guessed.
let defaultBrowserCache={at:0,id:''};
async function defaultBrowser(){
  if(!MAC)return '';
  if(defaultBrowserCache.id && Date.now()-defaultBrowserCache.at<10*60_000)return defaultBrowserCache.id;
  let id='';
  const plist=path.join(os.homedir(),'Library','Preferences','com.apple.LaunchServices','com.apple.launchservices.secure.plist');
  try{
    const json=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',plist],{timeout:4000}));
    const handlers=Array.isArray(json?.LSHandlers)?json.LSHandlers:[];
    const http=handlers.find(h=>h?.LSHandlerURLScheme==='http');
    id=String(http?.LSHandlerRoleAll || http?.LSHandlerRoleViewer || '').toLowerCase();
  }catch{}
  if(!id)id='com.apple.safari';
  defaultBrowserCache={at:Date.now(),id};
  return id;
}
// Chrome keeps its tabs in the same shape as Safari, so one path covers both.
const CHROME_IDS=new Set(['com.google.chrome','com.google.chrome.beta','com.google.chrome.canary','com.brave.browser','com.microsoft.edgemac']);
function browserName(id){
  if(CHROME_IDS.has(id))return id==='com.microsoft.edgemac'?'Microsoft Edge':id==='com.brave.browser'?'Brave Browser':'Google Chrome';
  return 'Safari';
}
const CHROME_TABS=app=>`tell application "${app}"\nset out to ""\nrepeat with w from 1 to count of windows\nrepeat with t from 1 to count of tabs of window w\nset out to out & w & "\\t" & t & "\\t" & (title of tab t of window w) & "\\t" & (URL of tab t of window w) & "\\n"\nend repeat\nend repeat\nreturn out\nend tell`;
async function browserTabs(){
  if(!MAC)return [];
  const id=await defaultBrowser();
  const app=browserName(id);
  const script=app==='Safari'?SAFARI_TABS:CHROME_TABS(app);
  let out='';
  try{out=await run('/usr/bin/osascript',['-e',script],{timeout:8000});}catch(error){throw Error(automationMessage(error,app));}
  return out.split('\n').map(line=>line.split('\t')).filter(parts=>parts.length>=4)
    .map(([w,t,name,url])=>({kind:'tab',id:'tab:'+w+':'+t,label:(name || url).slice(0,120),detail:app+' \u00b7 '+hostOf(url),target:{window:Number(w),tab:Number(t),app},url}));
}
async function focusBrowserTab({window:w,tab:t,app}={}){
  if(!MAC)return false;
  const name=String(app || 'Safari').replace(/"/g,'');
  const script=name==='Safari'
    ? `tell application "Safari"\nactivate\nset current tab of window ${Number(w)} to tab ${Number(t)} of window ${Number(w)}\nset index of window ${Number(w)} to 1\nend tell`
    : `tell application "${name}"\nactivate\nset active tab index of window ${Number(w)} to ${Number(t)}\nset index of window ${Number(w)} to 1\nend tell`;
  try{await run('/usr/bin/osascript',['-e',script],{timeout:8000});return true;}catch(error){throw Error(automationMessage(error,name));}
}

module.exports={openInBrowser,defaultBrowser,browserName,browserTabs,focusBrowserTab,appIconFile,appIconPng,listApps,findDocs,openApp,openFile,safariTabs,focusSafariTab,raiseWindow,deepLinkFor,isAppPath,prettyDir,MAC,WIN};
