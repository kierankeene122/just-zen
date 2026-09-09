import {marked} from './node_modules/marked/lib/marked.esm.js';
import {createWhiteboard} from './whiteboard.js';
import {rank} from './palette-match.mjs';
import {createBrain} from './brain.js';
const $=id=>document.getElementById(id);
let homeDir='';const pretty=value=>value && homeDir && value.startsWith(homeDir)?'~'+value.slice(homeDir.length):value;
const call=(name,...args)=>window.hearth.call(name,...args);
let root,claudeRoot=null,claudePolicy='notes',claudeWorkspaces=[],currentFile,original='',directory='',page='overview',running=false,mode='chat',theme='light';
let layout={agentCollapsed:false,centreCollapsed:false,navCollapsed:true},catalog=[],catalogPage=0,noteMode='preview';
let serviceFolders=[],todos=[],taskTab='todo';
let chatState={messages:[],busy:false,pending:[]};
let securityLoading=false,securityStatus=null;
// Web apps: tabs per app, up to four tiles on screen, and the pinned Browser.
const BROWSER_KEY='browser';
let tabs={},tiles={mode:'1',slots:[null,null,null,null],focus:0},viewsSuspended=0,sleep={defaultMinutes:0,apps:{}};
const tabLive=new Map(),asleep=new Set();
const terminal=new Terminal({fontFamily:'Menlo, monospace',fontSize:12,lineHeight:1.25,cursorBlink:true,scrollback:5000});
const fit=new FitAddon.FitAddon();terminal.loadAddon(fit);terminal.open($('terminal'));
const whiteboard=createWhiteboard({save:value=>call('save-whiteboard',value),notice});
function notice(text){$('status').textContent=text;}
async function attempt(fn){try{return await fn();}catch(e){notice(e.message.replace(/^Error invoking remote method '[^']+': Error: /,''));}}
function dirty(){return currentFile && $('editor').value!==original;}
function discard(){return !dirty() || confirm('Discard unsaved changes to this file?');}
function markdown(text){return DOMPurify.sanitize(marked.parse(text,{gfm:true}),{FORBID_TAGS:['img','iframe','form','input','button','style'],FORBID_ATTR:['style']});}
const brain=createBrain({menu:$('brain-menu'),play:$('brain-play'),stats:$('brain-stats'),notice});

function applyTheme(value){theme=value;document.body.dataset.theme=value;$('theme-toggle').textContent=value==='light'?'☾ Dark':'☀ Light';$('theme-toggle').setAttribute('aria-label',value==='light'?'Switch to dark mode':'Switch to light mode');terminal.options.theme=value==='light'?{background:'#fbfcfe',foreground:'#354258',cursor:'#5278c8',selectionBackground:'#e6eefc'}:{background:'#151816',foreground:'#d5ddcc',cursor:'#c4d3ab',selectionBackground:'#424e36'};}
function size(){if(!running || mode!=='terminal' || layout.agentCollapsed)return;fit.fit();call('terminal-size',{cols:terminal.cols,rows:terminal.rows}).catch(()=>{});}
async function applyLayout(next,persist=true){layout={...layout,...next};if(layout.centreCollapsed)layout.agentCollapsed=false;document.body.classList.toggle('agent-collapsed',layout.agentCollapsed);document.body.classList.toggle('centre-collapsed',layout.centreCollapsed);document.body.classList.toggle('nav-collapsed',layout.navCollapsed);$('collapse-nav').textContent=layout.navCollapsed?'›':'‹';$('collapse-nav').setAttribute('aria-label',layout.navCollapsed?'Expand sidebar':'Collapse sidebar');$('agent-rail').classList.toggle('hidden',!layout.agentCollapsed);$('restore-centre').classList.toggle('hidden',!layout.centreCollapsed);placeViews();size();if(persist)await saveLayout();}
let layoutSaveTimer=null;function saveLayout(){clearTimeout(layoutSaveTimer);return new Promise(resolve=>{layoutSaveTimer=setTimeout(()=>resolve(call('appearance',{layout:{...layout,tiles}}).catch(()=>{})),150);});}
function applyMode(next){mode=next;$('mode-chat').setAttribute('aria-pressed',next==='chat');$('mode-terminal').setAttribute('aria-pressed',next==='terminal');$('chat-view').classList.toggle('hidden',next!=='chat');$('agent-empty').classList.toggle('hidden',next!=='terminal' || running);$('terminal').classList.toggle('hidden',next!=='terminal' || !running);updateAgentStatus();size();}
function updateAgentStatus(){const state=mode==='chat'?(chatState.busy?(chatState.pending.length?'Needs your approval':'Working…'):'Chat · Claude Code'):(running?'Terminal · running':'Terminal · ready');$('agent-state').textContent=state;$('rail-state').textContent=chatState.pending.length?'●':chatState.busy || running?'·':'';}
async function show(next){page=next;if(layout.centreCollapsed)await applyLayout({centreCollapsed:false});['overview','files-page','browser-page','brain-page','security-page'].forEach(id=>$(id).classList.toggle('hidden',id!==next));$('home').classList.toggle('selected',next==='overview');$('vault').classList.toggle('selected',next==='files-page');$('browser-nav').classList.toggle('selected',next==='browser-page' && tiles.slots.slice(0,slotCount()).some(s=>s?.serviceKey===BROWSER_KEY));$('security-nav').classList.toggle('selected',next==='security-page');$('brain-nav').classList.toggle('selected',next==='brain-page');placeViews();if(next==='security-page')await renderSecurityStatus();if(next!=='brain-page')brain.stop();}
async function renderSecurityStatus(){if(securityLoading)return;securityLoading=true;try{const status=securityStatus=await call('security-status');$('security-signature').textContent=status.signature;$('security-gatekeeper').textContent=status.gatekeeper;$('security-updates').textContent=status.updates;$('security-engine').textContent='Electron '+status.electron+' · Chromium '+status.chromium;$('security-engine').title=status.engineSupport || '';$('security-engine-support').textContent=status.engineSupport || '';const p=status.profiles,c=status.claude,l=status.lock;$('security-profile-summary').textContent=`${status.encrypted?'Keychain-encrypted state':'Encryption unavailable'} · ${p.shared} Shared · ${p.personal} Personal · ${p.work} Work · ${p.isolated} Isolated · ${status.liveViews} web page${status.liveViews===1?'':'s'} in memory · Claude Chat: ${c.sandboxed?'OS sandbox active':'not sandboxed'}.`;$('lock-description').textContent=l.enabled?`${l.method==='passcode'?'Passcode':'Touch ID'} lock is enabled and activates after ${l.minutes} minutes of inactivity.`:l.touchID?'Local state is encrypted. Enable Touch ID to lock the visible workspace after inactivity.':'Touch ID is unavailable. Choose a passcode of at least six characters; local state remains Keychain-encrypted.';$('auto-lock-minutes').value=String(l.minutes);$('auto-lock-minutes').disabled=false;$('new-lock-passcode').classList.toggle('hidden',l.touchID || l.enabled);$('toggle-app-lock').disabled=false;$('toggle-app-lock').textContent=l.enabled?'Disable app lock':l.touchID?'Enable Touch ID lock':'Enable passcode lock';$('lock-now').disabled=!l.enabled;sleep=status.sleep || sleep;$('sleep-default').value=String(sleep.defaultMinutes);const custom=Object.keys(sleep.apps || {}).length;$('sleep-summary').textContent=custom?custom+' app'+(custom===1?' has':'s have')+' their own setting.':'';const target=$('clear-profile-target'),selected=target.value;target.replaceChildren(new Option('Browser tab','browser'),new Option('Shared login group','shared'),new Option('Personal login group','personal'),new Option('Work login group','work'));for(const item of sidebarItems.filter(item=>item.url && (item.profile || 'isolated')==='isolated'))target.add(new Option('Isolated · '+item.name,'isolated:'+encodeURIComponent(item.id || item.url)));if([...target.options].some(option=>option.value===selected))target.value=selected;}finally{securityLoading=false;}}
function setLocked(value,method){if(typeof value==='object'){method=value.method;value=value.locked;}document.body.classList.toggle('is-locked',value);$('lock-screen').classList.toggle('hidden',!value);if(value){const passcode=method==='passcode';$('unlock-passcode').classList.toggle('hidden',!passcode);$('lock-screen-copy').textContent=passcode?'Enter your Just Zen passcode to restore this workspace.':'Use Touch ID to restore your workspace.';$('unlock-app').textContent=passcode?'Unlock':'Unlock with Touch ID';(passcode?$('unlock-passcode'):$('unlock-app')).focus();closePopovers();}else $('unlock-passcode').value='';placeViews();}
function showVersion(state){if(state?.version)$('app-version').textContent='JUST ZEN · '+state.version;}
function hydrate(state){homeDir=state.home || homeDir;showVersion(state);attempt(refreshClaudeAuth);serviceBadges.clear();for(const [key,count] of Object.entries(state.serviceBadges || {}))serviceBadges.set(key,count);setLocked(false);setRoot(state.root);renderConnectedFolders(state.connectedFolders || []);setClaudeAccess({root:state.claudeRoot,policy:state.claudePolicy,workspaces:state.claudeWorkspaces});tabs=state.tabs || {};sleep=state.sleep || sleep;asleep.clear();for(const key of state.asleep || [])asleep.add(key);const saved=state.layout?.tiles;tiles=saved?{mode:saved.mode || '1',slots:Array.from({length:4},(_,i)=>saved.slots?.[i] || null),focus:saved.focus || 0}:{mode:'1',slots:[null,null,null,null],focus:0};services(state.services,state.serviceFolders);todos=state.todos;whiteboard.setBoard(state.whiteboard);renderTodos();applyTheme(state.theme);renderChat(state.chat);applyMode(state.mode);renderTiles();return applyLayout({...state.layout,navCollapsed:layout.navCollapsed},false);}
function setRoot(value){root=value;$('folder-name').textContent=value?value.split('/').pop():'Make yourself at home';$('folder-path').textContent=pretty(value) || 'Connect a vault or project to begin.';$('choose-folder').textContent='Add folder';}
function setClaudeAccess({root:nextRoot,policy=claudePolicy,workspaces=claudeWorkspaces}){claudeRoot=nextRoot || null;claudePolicy=policy;claudeWorkspaces=workspaces || [];$('claude-workspace').replaceChildren(new Option('No folder connected',''));for(const value of claudeWorkspaces)$('claude-workspace').add(new Option(value.split('/').pop(),value));$('claude-workspace').value=claudeRoot || '';$('claude-workspace').title=pretty(claudeRoot) || '';$('claude-policy').value=claudePolicy;$('claude-policy').disabled=!claudeRoot;$('disconnect-claude').disabled=!claudeRoot;$('chat-folder').textContent=claudeRoot?claudeRoot.split('/').pop():'Choose a Claude workspace to begin';$('chat-folder').title=pretty(claudeRoot) || '';const notes={full:'Full access to the selected folder. Shell commands still require explicit review.',notes:'Markdown changes are allowed. Other writes and commands require explicit approval.',readOnly:'Read tools only. File changes and commands are blocked in Chat.'};$('claude-access-note').textContent=claudeRoot?pretty(claudeRoot)+' · '+notes[claudePolicy]:'Claude is disconnected from local files.';document.body.classList.toggle('claude-disconnected',!claudeRoot);}
async function chooseClaude(){const state=await call('choose-claude-folder');if(state){setClaudeAccess(state);notice('Claude can now access '+pretty(state.root));return true;}return false;}
async function choose(){if(!discard())return;const value=await call('choose-folder');if(value){setRoot(value);const state=await call('state');renderConnectedFolders(state.connectedFolders || []);setClaudeAccess({root:state.claudeRoot,policy:state.claudePolicy,workspaces:state.claudeWorkspaces});currentFile=null;original='';$('editor').value='';$('editor').disabled=true;$('save').disabled=true;$('note-tabs').classList.add('hidden');$('markdown-preview').classList.add('hidden');$('editor').classList.remove('hidden');$('filename').textContent='Select a note or source file';directory='';await show('files-page');await list('');notice('Connected to '+pretty(value));}}
async function openFile(relative){if(!discard())return;const content=await call('read',relative);currentFile=relative;original=content.text;$('editor').value=original;$('editor').disabled=false;$('save').disabled=true;$('filename').textContent=relative;const md=/\.(md|markdown)$/i.test(relative);$('note-tabs').classList.toggle('hidden',!md);setNoteMode(md?'preview':'edit');}
async function list(relative){if(!root)return;directory=relative;const entries=await call('files',relative);$('file-list').replaceChildren();if(relative){const b=document.createElement('button');b.className='file-entry';b.textContent='← Parent folder';b.onclick=()=>attempt(()=>list(relative.split('/').slice(0,-1).join('/')));$('file-list').append(b);}for(const item of entries){const b=document.createElement('button');b.className='file-entry';b.textContent=(item.folder?'▸ ':'· ')+item.name;b.title=item.path;b.onclick=()=>attempt(()=>item.folder?list(item.path):openFile(item.path));$('file-list').append(b);}}
function setNoteMode(value){noteMode=value;$('editor').classList.toggle('hidden',value==='preview');$('markdown-preview').classList.toggle('hidden',value!=='preview');$('note-preview').setAttribute('aria-pressed',value==='preview');$('note-edit').setAttribute('aria-pressed',value==='edit');if(value==='preview'){
  let text=$('editor').value;const frontmatter=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);if(frontmatter)text=text.slice(frontmatter[0].length);
  text=text.replace(/\[\[([^\]\n]+)\]\]/g,(_m,raw)=>{const [target,label]=raw.split('|');return '['+(label || target).replace(/[\[\]<>]/g,'')+'](#vault-note='+encodeURIComponent(target)+')';});
  $('markdown-preview').innerHTML=markdown(text);
  if(frontmatter){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Note properties';pre.textContent=frontmatter[1];details.append(summary,pre);$('markdown-preview').prepend(details);}
}}
async function save(){if(!currentFile)return;const text=$('editor').value;await call('save',{relative:currentFile,text,original});original=text;$('save').disabled=true;notice('Saved '+currentFile);}
async function start(kind){if(kind!=='login' && !claudeRoot && !await chooseClaude())return;await call('start-terminal',kind);running=true;loginInProgress=kind==='login';await applyLayout({agentCollapsed:false});applyMode('terminal');requestAnimationFrame(size);terminal.focus();if(loginInProgress)notice('Signing in: finish in the browser window that opens, then return to Chat.');}
let loginInProgress=false;
async function refreshClaudeAuth(){try{const status=await call('claude-auth-status');$('chat-signin').classList.toggle('hidden',status.loggedIn);$('claude-login').classList.toggle('hidden',status.loggedIn);$('claude-logout').classList.toggle('hidden',!status.loggedIn);}catch{}}
$('claude-logout').onclick=()=>attempt(async()=>{if(!confirm('Sign out of Claude in Just Zen? Saved Just Zen conversations are cleared; Claude Code keeps its own history.'))return;await call('claude-logout');await refreshClaudeAuth();notice('Signed out of Claude.');});
$('chat-signin-button').onclick=()=>attempt(()=>start('login'));

// ---- Tiles, tabs and the Browser ----
const SLOTS={'1':1,'2h':2,'2v':2,'4':4};
function slotCount(){return SLOTS[tiles.mode] || 1;}
function liveKey(serviceKey,tabId){return serviceKey+'\n'+tabId;}
function serviceOf(key){if(key===BROWSER_KEY)return {id:BROWSER_KEY,name:'Browser',kind:'browser',url:''};return sidebarItems.find(item=>item.url && (item.id || item.url)===key) || null;}
function isSlack(item){try{const host=new URL(item.url).hostname;return host==='slack.com' || host.endsWith('.slack.com');}catch{return false;}}
function tabOf(slot){const group=tabs[slot.serviceKey];if(!group)return null;return group.items.find(t=>t.id===slot.tabId) || null;}
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}}
function tabTitle(serviceKey,tab){const live=tabLive.get(liveKey(serviceKey,tab.id));const url=live?.url || tab.current || tab.url;return live?.title || tab.title || hostOf(url) || 'New tab';}
function normaliseSlots(){for(let i=0;i<4;i++){const slot=tiles.slots[i];if(!slot)continue;const group=tabs[slot.serviceKey];if(!group || !serviceOf(slot.serviceKey)){tiles.slots[i]=null;continue;}if(!group.items.some(t=>t.id===slot.tabId))tiles.slots[i]={serviceKey:slot.serviceKey,tabId:group.active};}for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)if(tiles.slots[i] && tiles.slots[j] && tiles.slots[i].serviceKey===tiles.slots[j].serviceKey)tiles.slots[j]=null;tiles.focus=Math.min(tiles.focus,slotCount()-1);}
let placeScheduled=false;
function placeViews(){if(placeScheduled)return;placeScheduled=true;requestAnimationFrame(()=>{placeScheduled=false;placeNow().catch(()=>{});});}
async function placeNow(){
 const list=[];
 if(page==='browser-page' && !layout.centreCollapsed && !viewsSuspended && !document.body.classList.contains('is-locked')){
  for(let i=0;i<slotCount();i++){const slot=tiles.slots[i];if(!slot)continue;const tab=tabOf(slot);if(!tab || !(tab.current || tab.url))continue;const surface=$('tiles').children[i]?.querySelector('.tile-surface');if(!surface)continue;const r=surface.getBoundingClientRect();if(r.width<10 || r.height<10)continue;list.push({serviceKey:slot.serviceKey,tabId:slot.tabId,x:r.x,y:r.y,width:r.width,height:r.height});}
 }
 const infos=await call('place-views',list);
 for(const info of infos)tabLive.set(liveKey(info.serviceKey,info.tabId),info);
 refreshTileBars();
}
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function renderTiles(){
 normaliseSlots();
 const host=$('tiles');host.dataset.mode=tiles.mode;host.replaceChildren();
 for(const b of document.querySelectorAll('#layout-switch button'))b.setAttribute('aria-pressed',String(b.dataset.tiles===tiles.mode));
 const n=slotCount();
 for(let i=0;i<4;i++){
  const tile=el('div','tile');tile.dataset.slot=String(i);if(i>=n){tile.classList.add('hidden');host.append(tile);continue;}
  if(n>1 && i===tiles.focus)tile.classList.add('focused');
  const slot=tiles.slots[i],item=slot?serviceOf(slot.serviceKey):null,group=slot?tabs[slot.serviceKey]:null;
  const bar=el('div','tile-bar'),surface=el('div','tile-surface');
  tile.onmousedown=()=>{if(tiles.focus!==i && n>1){tiles.focus=i;for(const t of host.children)t.classList.toggle('focused',t===tile);saveLayout();}};
  if(!slot || !item || !group){
   bar.classList.add('hidden');
   const empty=el('div','tile-empty');empty.append(el('span','tile-empty-mark','⊞'),el('p',null,n>1?'Choose an app for this tile.':'Choose an app from the sidebar.'));
   const pick=document.createElement('select');pick.setAttribute('aria-label','App for this tile');pick.add(new Option('Choose an app…',''));pick.add(new Option('Browser',BROWSER_KEY));for(const s of sidebarItems.filter(s=>s.url))pick.add(new Option(s.name,s.id || s.url));
   pick.onchange=()=>{if(!pick.value)return;tiles.focus=i;attempt(()=>openInTile(pick.value));};empty.append(pick);surface.append(empty);
   tile.append(bar,surface);host.append(tile);continue;
  }
  const browser=slot.serviceKey===BROWSER_KEY;
  const showBar=browser || group.items.length>1 || n>1;
  bar.classList.toggle('hidden',!showBar);
  if(!browser){const label=el('button','tile-app');const img=el('img','site-favicon');img.alt='';img.hidden=true;const fallback=el('span','site-fallback',item.name.slice(0,1).toUpperCase());label.append(img,fallback,el('span',null,item.name));label.title=item.name;label.onclick=()=>{tiles.focus=i;};call('favicon',slot.serviceKey).then(icon=>paintIcon(img,icon)).catch(()=>{});bar.append(label);}
  const strip=el('div','tile-tabs');
  for(const tab of group.items){
   const b=el('button','tile-tab');b.type='button';b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab.id===slot.tabId));b.dataset.tab=tab.id;b.title=tabLive.get(liveKey(slot.serviceKey,tab.id))?.url || tab.current || tab.url || 'New tab';
   const text=el('span',null,tabTitle(slot.serviceKey,tab));const close=el('b','tile-tab-close','×');close.title='Close tab';
   close.onclick=e=>{e.stopPropagation();attempt(()=>closeTab(slot.serviceKey,tab.id));};
   b.onclick=()=>{if(tab.id!==slot.tabId)attempt(()=>activateTab(i,slot.serviceKey,tab.id));};
   b.onauxclick=e=>{if(e.button===1)attempt(()=>closeTab(slot.serviceKey,tab.id));};
   b.append(text,close);strip.append(b);
  }
  bar.append(strip);
  const plus=el('button','tile-new','+');plus.type='button';plus.title=isSlack(item)?'Add another Slack workspace':'New tab (⌘T)';plus.onclick=()=>attempt(()=>newTab(slot.serviceKey));bar.append(plus);
  if(browser){
   const form=el('form','tile-url');
   for(const [action,glyph,title] of [['back','‹','Back'],['forward','›','Forward'],['reload','↻','Reload']]){const b=el('button',null,glyph);b.type='button';b.dataset.nav=action;b.title=title;b.onclick=()=>attempt(async()=>{const info=await call('tab-action',{serviceKey:slot.serviceKey,tabId:slot.tabId,action});if(info)tabLive.set(liveKey(info.serviceKey,info.tabId),info);refreshTileBars();});form.append(b);}
   const address=document.createElement('input');address.className='tile-address';address.type='text';address.autocomplete='off';address.spellcheck=false;address.placeholder='Enter a website address';address.setAttribute('aria-label','Address');
   const live=tabLive.get(liveKey(slot.serviceKey,slot.tabId)),tab=tabOf(slot);address.value=live?.url || tab?.current || tab?.url || '';
   address.onfocus=()=>address.select();
   form.append(address);form.onsubmit=e=>{e.preventDefault();const value=address.value.trim();if(!value)return;attempt(async()=>{const target=/^[a-z][a-z0-9+.-]*:/i.test(value)?value:/^[^\s]+\.[^\s]+$/.test(value)?'https://'+value:'https://duckduckgo.com/?q='+encodeURIComponent(value);tabs[slot.serviceKey]=await call('navigate-tab',{serviceKey:slot.serviceKey,tabId:slot.tabId,url:target});renderTiles();});};
   bar.append(form);
  }
  if(n>1){const clear=el('button','tile-clear','×');clear.type='button';clear.title='Empty this tile';clear.onclick=()=>{tiles.slots[i]=null;renderTiles();saveLayout();};bar.append(clear);}
  const tab=tabOf(slot);
  if(!tab || !(tab.current || tab.url)){const empty=el('div','tile-empty');empty.append(el('span','tile-empty-mark','⌕'),el('p',null,'Type an address above, or paste a link.'));surface.append(empty);}
  else if(asleep.has(slot.serviceKey)){const empty=el('div','tile-empty');empty.append(el('span','tile-empty-mark','☾'),el('p',null,item.name+' was asleep. Waking it up…'));surface.append(empty);}
  tile.append(bar,surface);host.append(tile);
 }
 $('browser-nav').classList.toggle('selected',page==='browser-page' && tiles.slots.slice(0,n).some(s=>s?.serviceKey===BROWSER_KEY));
 placeViews();
}
function refreshTileBars(){
 const host=$('tiles');
 for(let i=0;i<slotCount();i++){const tile=host.children[i],slot=tiles.slots[i];if(!tile || !slot)continue;const group=tabs[slot.serviceKey];if(!group)continue;
  for(const b of tile.querySelectorAll('.tile-tab')){const tab=group.items.find(t=>t.id===b.dataset.tab);if(!tab)continue;const live=tabLive.get(liveKey(slot.serviceKey,tab.id));b.firstChild.textContent=tabTitle(slot.serviceKey,tab);b.title=live?.url || tab.current || tab.url || 'New tab';b.classList.toggle('loading',Boolean(live?.loading));}
  const address=tile.querySelector('.tile-address');const live=tabLive.get(liveKey(slot.serviceKey,slot.tabId));
  if(address && document.activeElement!==address && live?.url)address.value=live.url;
  const back=tile.querySelector('[data-nav=back]'),forward=tile.querySelector('[data-nav=forward]');if(back)back.disabled=!live?.canGoBack;if(forward)forward.disabled=!live?.canGoForward;
  if(live?.url && tile.querySelector('.tile-empty') && !asleep.has(slot.serviceKey))tile.querySelector('.tile-empty').remove();
 }
}
async function openInTile(serviceKey,tabId){
 if(!tabs[serviceKey])tabs=await call('tabs');
 const group=tabs[serviceKey];if(!group)throw Error('App not found');
 tabId=group.items.some(t=>t.id===tabId)?tabId:group.active;
 const n=slotCount();let index=tiles.slots.findIndex((s,i)=>i<n && s && s.serviceKey===serviceKey);
 if(index<0)index=tiles.slots.findIndex((s,i)=>i<n && !s);
 if(index<0)index=Math.min(tiles.focus,n-1);
 tiles.slots[index]={serviceKey,tabId};tiles.focus=index;
 if(group.active!==tabId){group.active=tabId;call('activate-tab',{serviceKey,tabId}).catch(()=>{});}
 closePopovers();await show('browser-page');renderTiles();saveLayout();
 if(serviceKey===BROWSER_KEY){const tab=group.items.find(t=>t.id===tabId);if(tab && !(tab.current || tab.url))focusAddress(index);}
}
function focusAddress(index=tiles.focus){requestAnimationFrame(()=>{const address=$('tiles').children[index]?.querySelector('.tile-address');if(address){address.focus();address.select();}});}
async function openBrowser(url){if(url){const opened=await call('open-tab',{serviceKey:BROWSER_KEY,url});tabs[BROWSER_KEY]=opened.tabs;await openInTile(BROWSER_KEY,opened.tabId);}else await openInTile(BROWSER_KEY);}
async function activateTab(index,serviceKey,tabId){tabs[serviceKey]=await call('activate-tab',{serviceKey,tabId});tiles.slots[index]={serviceKey,tabId};renderTiles();saveLayout();}
async function newTab(serviceKey){const item=serviceOf(serviceKey);if(!item)return;const url=isSlack(item)?'https://slack.com/signin':'';const opened=await call('open-tab',{serviceKey,url});tabs[serviceKey]=opened.tabs;await openInTile(serviceKey,opened.tabId);if(isSlack(item))notice('Sign in to the other workspace here; it opens in its own tab beside this one.');}
async function closeTab(serviceKey,tabId){tabs[serviceKey]=await call('close-tab',{serviceKey,tabId});tabLive.delete(liveKey(serviceKey,tabId));renderTiles();saveLayout();}
function focusedSlot(){const n=slotCount();return tiles.slots[Math.min(tiles.focus,n-1)] || tiles.slots.slice(0,n).find(Boolean) || null;}
async function setTilesMode(nextMode){if(!SLOTS[nextMode])return;tiles.mode=nextMode;if(page!=='browser-page')await show('browser-page');renderTiles();saveLayout();}
function suspendViews(){viewsSuspended++;placeViews();}
function resumeViews(){viewsSuspended=Math.max(0,viewsSuspended-1);placeViews();}
for(const b of document.querySelectorAll('#layout-switch button'))b.onclick=()=>attempt(()=>setTilesMode(b.dataset.tiles));
$('browser-nav').onclick=()=>attempt(()=>openBrowser());
window.hearth.on('tab-update',info=>{tabLive.set(liveKey(info.serviceKey,info.tabId),info);const group=tabs[info.serviceKey];const tab=group?.items.find(t=>t.id===info.tabId);if(tab){if(info.url)tab.current=info.url;if(info.title)tab.title=info.title;}refreshTileBars();});
window.hearth.on('tab-opened',({serviceKey,tabId,tabs:group})=>{tabs[serviceKey]=group;const n=slotCount();const index=tiles.slots.findIndex((s,i)=>i<n && s && s.serviceKey===serviceKey);if(index>=0){tiles.slots[index]={serviceKey,tabId};renderTiles();saveLayout();}});
window.hearth.on('tab-command',command=>attempt(async()=>{
 if(command==='new'){const slot=page==='browser-page'?focusedSlot():null;await newTab(slot?slot.serviceKey:BROWSER_KEY);return;}
 if(command==='address'){await openBrowser();focusAddress();return;}
 if(page!=='browser-page')return;const slot=focusedSlot();if(!slot)return;
 if(command==='close')await closeTab(slot.serviceKey,slot.tabId);
 else if(command==='reload')await call('tab-action',{serviceKey:slot.serviceKey,tabId:slot.tabId,action:'reload'});
}));
window.hearth.on('service-asleep',({key,asleep:value})=>{if(value)asleep.add(key);else asleep.delete(key);for(const row of document.querySelectorAll('.service-row'))if(row.dataset.key===key){row.classList.toggle('asleep',value);const zz=row.querySelector('.zz');if(zz)zz.hidden=!value;}if(!value)refreshTileBars();});
new ResizeObserver(placeViews).observe($('tiles'));new ResizeObserver(placeViews).observe(document.body);

// ---- Sidebar: apps, groups, popovers ----
let sidebarItems=[],dragKey=null;const serviceBadges=new Map();
function paintIcon(img,icon){if(icon){img.src=icon;img.hidden=false;img.nextElementSibling.hidden=true;}}
function closePopovers(){$('ctx-menu').classList.add('hidden');$('ctx-menu').replaceChildren();if(!$('mega-menu').classList.contains('hidden')){$('mega-menu').classList.add('hidden');$('mega-menu').replaceChildren();resumeViews();}if(popoverSuspended){popoverSuspended=false;resumeViews();}}
let popoverSuspended=false;
function showMenu(items,x,y){
 closePopovers();const menu=$('ctx-menu');
 for(const item of items){if(item==='-'){menu.append(document.createElement('hr'));continue;}const b=el('button',item.checked?'checked':'',item.label);b.type='button';b.onclick=()=>{if(item.keep){showMenu(item.run(),x,y);return;}closePopovers();attempt(()=>item.run());};menu.append(b);}
 menu.classList.remove('hidden');popoverSuspended=true;suspendViews();
 const w=menu.offsetWidth,h=menu.offsetHeight;menu.style.left=Math.max(4,Math.min(x,innerWidth-w-8))+'px';menu.style.top=Math.max(4,Math.min(y,innerHeight-h-8))+'px';
}
document.addEventListener('mousedown',e=>{if(!e.target.closest('#ctx-menu') && !e.target.closest('#mega-menu') && !e.target.closest('.service-group'))closePopovers();},{capture:true});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closePopovers();});
const SLEEP_LABELS={0:'Never',5:'5 minutes',15:'15 minutes',30:'30 minutes',60:'1 hour',120:'2 hours'};
function sleepMenu(key){const own=sleep.apps?.[key];const items=[{label:'Use the default ('+SLEEP_LABELS[sleep.defaultMinutes]+')',checked:own===undefined,run:()=>setSleep(key,null)}];for(const minutes of [0,5,15,30,60,120])items.push({label:minutes?'Sleep after '+SLEEP_LABELS[minutes]+' hidden':'Never sleep',checked:own===minutes,run:()=>setSleep(key,minutes)});return items;}
async function setSleep(key,minutes){sleep=await call('set-sleep',{key,minutes});notice(minutes===null?'Using the default sleep setting.':minutes?'Sleeps after '+SLEEP_LABELS[minutes]+' hidden.':'Never put to sleep.');}
function groupMenu(key){const item=sidebarItems.find(s=>(s.id || s.url)===key);const items=serviceFolders.map(folder=>({label:folder.icon+' '+folder.name,checked:item?.folderId===folder.id,run:async()=>{const state=await call('set-service-folder',{key,folderId:folder.id});services(state.services,state.folders);notice('Moved into '+folder.name+'.');}}));items.push({label:'No group',checked:!item?.folderId,run:async()=>{const state=await call('set-service-folder',{key,folderId:null});services(state.services,state.folders);}});items.push('-',{label:'New group…',run:()=>openPicker('group')});return items;}
function rowMenu(item,x,y){
 const key=item.id || item.url;
 showMenu([{label:'Open',run:()=>openService(item)},{label:isSlack(item)?'Add another Slack workspace':'Open in a new tab',run:()=>newTab(key)},{label:'Open beside the current app',run:async()=>{if(tiles.mode==='1')tiles.mode='2h';await openInTile(key);}},'-',{label:'Sleep when hidden…',keep:true,run:()=>sleepMenu(key)},{label:'Move to group…',keep:true,run:()=>groupMenu(key)},'-',{label:'Remove '+item.name,run:async()=>{if(!confirm('Remove '+item.name+' from the sidebar?'))return;services(await call('remove-service',key));notice(item.name+' removed from the sidebar.');}}],x,y);
}
function serviceRow(item){
 const key=item.id || item.url;const row=document.createElement('div');row.className='service-row';row.dataset.key=key;row.draggable=true;if(asleep.has(key))row.classList.add('asleep');
 row.ondragstart=e=>{dragKey=key;e.dataTransfer.setData('text/plain',key);e.dataTransfer.effectAllowed='move';row.classList.add('dragging');};
 row.ondragend=()=>{dragKey=null;document.querySelectorAll('.service-row,.service-group').forEach(r=>r.classList.remove('dragging','drop-target'));};
 row.ondragover=e=>{if(dragKey && dragKey!==key){e.preventDefault();row.classList.add('drop-target');}};row.ondragleave=()=>row.classList.remove('drop-target');
 row.ondrop=e=>{e.preventDefault();e.stopPropagation();row.classList.remove('drop-target');if(!dragKey || dragKey===key)return;const keys=sidebarItems.map(s=>s.id || s.url);const source=keys.indexOf(dragKey),target=keys.indexOf(key);keys.splice(source,1);keys.splice(target,0,dragKey);const moved=dragKey;attempt(async()=>{let items=await call('reorder-services',keys);const dragged=items.find(s=>(s.id || s.url)===moved);if(dragged && (dragged.folderId || null)!==(item.folderId || null)){const state=await call('set-service-folder',{key:moved,folderId:item.folderId || null});items=state.services;serviceFolders=state.folders;}services(items);notice('Sidebar order saved.');});};
 row.oncontextmenu=e=>{e.preventDefault();rowMenu(item,e.clientX,e.clientY);};
 const grip=document.createElement('button');grip.className='reorder-handle';grip.textContent='⠿';grip.title='Drag to reorder. Use Option + ↑ or ↓ to move.';grip.setAttribute('aria-label','Reorder '+item.name);grip.onkeydown=e=>{if(!e.altKey || !['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const keys=sidebarItems.map(s=>s.id || s.url),i=keys.indexOf(key),next=i+(e.key==='ArrowUp'?-1:1);if(next<0 || next>=keys.length)return;[keys[i],keys[next]]=[keys[next],keys[i]];attempt(async()=>{services(await call('reorder-services',keys));document.querySelector(`.service-row[data-key="${CSS.escape(key)}"] .reorder-handle`)?.focus();notice(item.name+' moved '+(next<i?'up':'down'));});};
 const b=document.createElement('button');b.className='nav';const img=document.createElement('img');img.className='site-favicon';img.alt='';img.hidden=true;img.dataset.site=item.url || '';const fallback=document.createElement('span');fallback.className='site-fallback';fallback.textContent=item.name.slice(0,1).toUpperCase();const label=document.createElement('span');label.textContent=item.name;const zz=document.createElement('small');zz.className='zz';zz.textContent='zz';zz.title='Asleep to save memory';zz.hidden=!asleep.has(key);const badge=document.createElement('small');badge.className='service-badge';badge.dataset.badgeKey=key;const count=serviceBadges.get(key) || 0;badge.textContent=count>99?'99+':String(count || '');badge.hidden=!count;b.append(img,fallback,label,zz,badge);b.title=item.name;b.onclick=()=>attempt(()=>openService(item));
 const profile=document.createElement('select');profile.className='service-profile';profile.title='Browser profile for '+item.name;profile.setAttribute('aria-label','Browser profile for '+item.name);for(const [value,label] of [['isolated','Isolated'],['shared','Shared'],['personal','Personal'],['work','Work']])profile.add(new Option(label,value));profile.value=item.profile || 'isolated';profile.onclick=e=>e.stopPropagation();profile.onchange=()=>attempt(async()=>{services(await call('set-service-profile',{key,profile:profile.value}));notice(item.name+' now uses the '+profile.options[profile.selectedIndex].text+' profile. Sign in within that profile if needed.');});
 const remove=document.createElement('button');remove.className='remove-service';remove.textContent='×';remove.title='Remove '+item.name;remove.setAttribute('aria-label','Remove '+item.name);remove.onclick=()=>attempt(async()=>{services(await call('remove-service',key));notice(item.name+' removed from the sidebar.');});row.append(grip,b);if(item.url)row.append(profile);row.append(remove);
 if(item.url)call('favicon',key).then(icon=>paintIcon(img,icon)).catch(()=>{});
 return row;
}
function groupRow(folder,members){
 const row=document.createElement('div');row.className='service-group';row.dataset.folder=folder.id;
 const b=document.createElement('button');b.className='nav';b.title=folder.name+' · '+members.length+' app'+(members.length===1?'':'s');
 const icon=document.createElement('span');icon.className='group-icon';icon.textContent=folder.icon || '◫';const label=document.createElement('span');label.textContent=folder.name;const count=document.createElement('small');count.className='group-count';count.textContent=String(members.length);
 const unread=members.reduce((sum,item)=>sum+(serviceBadges.get(item.id || item.url) || 0),0);const badge=document.createElement('small');badge.className='service-badge';badge.textContent=unread>99?'99+':String(unread || '');badge.hidden=!unread;
 b.append(icon,label,count,badge);b.onclick=e=>{e.stopPropagation();if(!$('mega-menu').classList.contains('hidden') && $('mega-menu').dataset.folder===folder.id){closePopovers();return;}openMegaMenu(folder,members,row);};
 b.oncontextmenu=e=>{e.preventDefault();groupRowMenu(folder,e.clientX,e.clientY);};
 row.ondragover=e=>{if(dragKey){e.preventDefault();row.classList.add('drop-target');}};row.ondragleave=()=>row.classList.remove('drop-target');
 row.ondrop=e=>{e.preventDefault();row.classList.remove('drop-target');if(!dragKey)return;attempt(async()=>{const state=await call('set-service-folder',{key:dragKey,folderId:folder.id});services(state.services,state.folders);notice('Moved into '+folder.name+'.');});};
 const remove=document.createElement('button');remove.className='remove-service';remove.textContent='×';remove.title='Remove group (apps stay in the sidebar)';remove.onclick=e=>{e.stopPropagation();attempt(()=>removeGroup(folder));};
 row.append(b,remove);return row;
}
function groupRowMenu(folder,x,y){showMenu([{label:'Open',run:()=>{const members=sidebarItems.filter(item=>item.folderId===folder.id);openMegaMenu(folder,members,document.querySelector(`.service-group[data-folder="${CSS.escape(folder.id)}"]`));}},{label:'Rename…',run:()=>renameGroup(folder)},{label:'Change icon…',run:()=>changeGroupIcon(folder)},'-',{label:'Remove group',run:()=>removeGroup(folder)}],x,y);}
async function renameGroup(folder){const name=prompt('Group name',folder.name);if(name===null || !name.trim())return;const state=await call('update-service-folder',{id:folder.id,name});services(state.services,state.folders);}
async function changeGroupIcon(folder){const icon=prompt('Icon for '+folder.name+' (an emoji)',folder.icon || '');if(icon===null)return;const state=await call('update-service-folder',{id:folder.id,icon});services(state.services,state.folders);}
async function removeGroup(folder){if(!confirm('Remove the group "'+folder.name+'"? Its apps stay in the sidebar.'))return;const state=await call('remove-service-folder',folder.id);services(state.services,state.folders);closePopovers();notice('Group removed.');}
function openMegaMenu(folder,members,anchor){
 closePopovers();const menu=$('mega-menu');menu.dataset.folder=folder.id;
 const head=el('div','mega-head');head.append(el('span','group-icon',folder.icon || '◫'),el('strong',null,folder.name));
 const edit=el('button','secondary','Edit');edit.type='button';edit.onclick=e=>{e.stopPropagation();groupRowMenu(folder,e.clientX,e.clientY);};const close=el('button','mega-close','×');close.type='button';close.title='Close';close.onclick=closePopovers;head.append(edit,close);menu.append(head);
 const grid=el('div','mega-grid');
 for(const item of members){
  const key=item.id || item.url;const tile=el('button','mega-tile');tile.type='button';const img=el('img','site-favicon');img.alt='';img.hidden=true;const fallback=el('span','site-fallback',item.name.slice(0,1).toUpperCase());
  const count=serviceBadges.get(key) || 0;const badge=el('small','service-badge',count>99?'99+':String(count || ''));badge.hidden=!count;
  tile.append(img,fallback,el('span',null,item.name),badge);tile.title=item.name+(item.url?' · '+hostOf(item.url):'');tile.onclick=()=>attempt(()=>openService(item));
  tile.oncontextmenu=e=>{e.preventDefault();rowMenu(item,e.clientX,e.clientY);};
  call('favicon',key).then(icon=>paintIcon(img,icon)).catch(()=>{});grid.append(tile);
 }
 if(!members.length){const p=el('p','mega-empty','Drag apps onto this group in the sidebar, or right-click an app and choose “Move to group”.');grid.append(p);}
 menu.append(grid);
 const add=el('button','text-button','+ Add apps to this group');add.type='button';add.onclick=()=>{closePopovers();openPicker('installed');};menu.append(add);
 menu.classList.remove('hidden');suspendViews();
 const rect=anchor.getBoundingClientRect(),aside=document.querySelector('aside').getBoundingClientRect();
 menu.style.left=Math.round(aside.right+10)+'px';menu.style.top=Math.max(72,Math.min(rect.top,innerHeight-menu.offsetHeight-48))+'px';
}
function services(items,folders=serviceFolders){sidebarItems=items;serviceFolders=folders;$('services').replaceChildren();$('services').ondragover=e=>{if(dragKey && !e.target.closest('.service-group'))e.preventDefault();};$('services').ondrop=e=>{if(!dragKey || e.target.closest('.service-group') || e.target.closest('.service-row'))return;e.preventDefault();attempt(async()=>{const state=await call('set-service-folder',{key:dragKey,folderId:null});services(state.services,state.folders);notice('Moved out of the group.');});};
 for(const folder of folders)$('services').append(groupRow(folder,items.filter(item=>item.folderId===folder.id)));
 for(const item of items.filter(item=>!item.folderId || !folders.some(folder=>folder.id===item.folderId)))$('services').append(serviceRow(item));
 for(const key of Object.keys(tabs))if(key!==BROWSER_KEY && !items.some(item=>(item.id || item.url)===key))delete tabs[key];
 if(page==='browser-page')renderTiles();
}
window.hearth.on('favicon',({url,icon})=>{for(const img of document.querySelectorAll('.site-favicon'))if(img.dataset.site===url)paintIcon(img,icon);});
window.hearth.on('service-badge',({key,count})=>{if(count)serviceBadges.set(key,count);else serviceBadges.delete(key);const badge=document.querySelector(`[data-badge-key="${CSS.escape(key)}"]`);if(badge){badge.textContent=count>99?'99+':String(count || '');badge.hidden=!count;}const item=sidebarItems.find(s=>(s.id || s.url)===key);if(item?.folderId){const folder=serviceFolders.find(f=>f.id===item.folderId);const row=folder && document.querySelector(`.service-group[data-folder="${CSS.escape(folder.id)}"]`);if(row)row.replaceWith(groupRow(folder,sidebarItems.filter(s=>s.folderId===folder.id)));}});
window.hearth.on('open-service',key=>{const item=sidebarItems.find(value=>(value.id || value.url)===key);if(item)attempt(()=>openService(item));});

function renderTodos(){const done=taskTab==='done';$('todo-tab').setAttribute('aria-pressed',!done);$('done-tab').setAttribute('aria-pressed',done);$('todo-form').classList.toggle('hidden',done);$('todo-list').replaceChildren();const list=todos.filter(todo=>todo.done===done);$('task-count').textContent=todos.filter(todo=>!todo.done).length || '';for(const todo of list){const row=document.createElement('label');row.className='todo-row';const box=document.createElement('input');box.type='checkbox';box.checked=todo.done;box.onchange=()=>attempt(async()=>{todos=await call('toggle-todo',todo.id);renderTodos();});const text=document.createElement('span');text.textContent=todo.text;row.append(box,text);$('todo-list').append(row);}if(!list.length){const empty=document.createElement('p');empty.className='todo-empty';empty.textContent=done?'Completed tasks will appear here.':'Nothing waiting. A clear list is a good list.';$('todo-list').append(empty);}}
async function openService(item){if(item.kind==='claude'){await applyLayout({agentCollapsed:false});if(mode==='terminal'){if(!running)await start('claude');terminal.focus();}else $('chat-input').focus();return;}if(item.kind==='vault'){if(!root){await choose();return;}await show('files-page');await list(directory);return;}if(item.kind==='browser' || (item.id || item.url)===BROWSER_KEY){await openBrowser();return;}await openInTile(item.id || item.url);}
const GROUP_ICONS=['💼','🎨','🧠','💬','📈','🛒','🎧','🧾','🏡','✈️','🧪','📚','🎮','💡','🧩','🌱','🔧','🧭','📷','🍵','⭐','❤️','🎯','🗂️'];
function pickerTab(which){$('installed-panel').classList.toggle('hidden',which!=='installed');$('website-form').classList.toggle('hidden',which!=='website');$('group-form').classList.toggle('hidden',which!=='group');$('tab-installed').setAttribute('aria-pressed',which==='installed');$('tab-website').setAttribute('aria-pressed',which==='website');$('tab-group').setAttribute('aria-pressed',which==='group');if(which==='website')$('website-url').focus();if(which==='group'){renderGroupForm();$('group-name').focus();}}
function renderGroupForm(){const icons=$('group-icons');if(!icons.children.length){for(const icon of GROUP_ICONS){const b=el('button',null,icon);b.type='button';b.setAttribute('aria-pressed','false');b.onclick=()=>{for(const other of icons.children)other.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');$('group-icon').value=icon;};icons.append(b);}}const apps=$('group-apps');apps.replaceChildren();for(const item of sidebarItems.filter(s=>s.url)){const label=document.createElement('label');const box=document.createElement('input');box.type='checkbox';box.value=item.id || item.url;const name=el('span',null,item.name);if(item.folderId){const folder=serviceFolders.find(f=>f.id===item.folderId);if(folder)name.textContent+=' · '+folder.name;}label.append(box,name);apps.append(label);}if(!sidebarItems.some(s=>s.url))apps.append(el('p','todo-empty','Add some apps first, then group them here.'));}
async function openPicker(tab='installed'){
  suspendViews();$('app-dialog').showModal();pickerTab(tab);$('app-search').value='';$('app-category').value='';catalogPage=0;$('app-list').textContent='Loading the app library…';catalog=await call('web-apps');
  $('app-category').replaceChildren(new Option('All categories',''));for(const category of [...new Set(catalog.map(a=>a.category))].sort())$('app-category').add(new Option(category,category));renderApps();if(tab==='installed')$('app-search').focus();
}
function renderApps(){
  const query=$('app-search').value.normalize('NFKD').toLowerCase().trim();const category=$('app-category').value;
  const matches=catalog.filter(a=>(!category || a.category===category) && query.split(/\s+/).every(term=>(a.name+' '+a.category+' '+a.url).normalize('NFKD').toLowerCase().includes(term)));
  const perPage=36,pages=Math.max(1,Math.ceil(matches.length/perPage));catalogPage=Math.min(catalogPage,pages-1);$('app-list').replaceChildren();
  $('app-count').textContent=matches.length.toLocaleString()+' of '+catalog.length.toLocaleString()+' apps';$('apps-page').textContent='Page '+(catalogPage+1)+' of '+pages;$('apps-prev').disabled=catalogPage===0;$('apps-next').disabled=catalogPage===pages-1;
  for(const item of matches.slice(catalogPage*perPage,(catalogPage+1)*perPage)){
    const row=document.createElement('div');row.className='app-row';const tile=document.createElement('img');tile.className='app-library-icon';tile.src=item.icon;tile.alt='';tile.width=34;tile.height=34;
    const info=document.createElement('div');info.className='app-info';const name=document.createElement('strong');name.textContent=item.name;const detail=document.createElement('small');detail.textContent=item.category;const address=document.createElement('small');address.className='app-domain';address.textContent=new URL(item.url).hostname.replace(/^www\./,'');info.append(name,detail,address);
    const add=document.createElement('button');add.className='secondary';add.textContent=item.added?'Added ✓':'+ Add';add.setAttribute('aria-label',(item.added?'Added ':'Add ')+item.name);add.disabled=item.added;
    add.onclick=()=>attempt(async()=>{add.disabled=true;try{services(await call('add-catalog-app',item.id));item.added=true;add.textContent='Added ✓';add.setAttribute('aria-label','Added '+item.name);notice(item.name+' added to your sidebar');}catch(e){add.disabled=false;throw e;}});
    row.append(tile,info,add);$('app-list').append(row);
  }
  if(!matches.length){const empty=document.createElement('p');empty.textContent='No matches. Try another search, or add a website link.';$('app-list').append(empty);}
}
const chatWelcome=$('chat-messages').firstElementChild.cloneNode(true);
const chatNodes=new Map(),permissionNodes=new Map();
function renderChat(state){chatState=state;const scroller=$('chat-messages');const nearBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<90;if(state.messages.length && scroller.querySelector('.chat-welcome'))scroller.replaceChildren();const ids=new Set(state.messages.map(m=>m.id));for(const [id,node] of chatNodes)if(!ids.has(id)){node.remove();chatNodes.delete(id);}
  for(const message of state.messages){let node=chatNodes.get(message.id);if(!node){node=document.createElement(message.role==='tool'?'details':'div');node.className='chat-message '+message.role;chatNodes.set(message.id,node);scroller.append(node);}const signature=JSON.stringify(message);if(node.dataset.signature===signature)continue;node.dataset.signature=signature;
    if(message.role==='tool'){const open=node.open;node.replaceChildren();const summary=document.createElement('summary');summary.textContent=message.tool+' · '+message.status;const pre=document.createElement('pre');pre.textContent=message.text+(message.output?'\n\n'+message.output:'');node.append(summary,pre);node.open=open;}
    else if(message.role==='assistant'){node.classList.add('markdown-body');node.innerHTML=markdown(message.text || '…');}
    else{node.textContent=message.text;}
  }
  if(!state.messages.length && !scroller.querySelector('.chat-welcome'))scroller.append(chatWelcome.cloneNode(true));
  const live=new Set((state.pending || []).map(p=>p.id));for(const [id,node] of permissionNodes)if(!live.has(id)){node.remove();permissionNodes.delete(id);}
  for(const request of state.pending || []){if(permissionNodes.has(request.id))continue;const card=document.createElement('div');card.className='permission-card';const title=document.createElement('strong');title.textContent=request.title;card.append(title);if(request.description){const p=document.createElement('p');p.textContent=request.description;card.append(p);}const answers={};if(request.tool==='AskUserQuestion'){for(const q of request.input.questions || []){const label=document.createElement('label');label.textContent=q.question;const field=document.createElement('textarea');field.rows=2;field.placeholder=(q.options || []).map(o=>o.label).join(' / ');label.append(field);card.append(label);answers[q.question]=field;}}else{const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Review action';pre.textContent=JSON.stringify(request.input,null,2);detail.append(summary,pre);detail.open=true;card.append(detail);}const actions=document.createElement('div');actions.className='dialog-actions';for(const allow of [false,true]){const b=document.createElement('button');b.className=allow?'primary':'secondary';b.textContent=allow?(request.tool==='AskUserQuestion'?'Send answer':'Allow once'):'Deny';b.onclick=()=>attempt(()=>call('chat-permission',{id:request.id,allow,answers:Object.fromEntries(Object.entries(answers).map(([q,f])=>[q,f.value]))}));actions.append(b);}card.append(actions);permissionNodes.set(request.id,card);$('chat-permissions').append(card);}
  $('chat-send').disabled=state.busy;$('new-chat').disabled=state.busy;updateAgentStatus();if(nearBottom)scroller.scrollTop=scroller.scrollHeight;
}
$('home').onclick=()=>attempt(()=>show('overview'));
$('vault').onclick=()=>attempt(async()=>{const state=await call('state');renderConnectedFolders(state.connectedFolders || []);await show('files-page');if(root)await list(directory);});
$('security-nav').onclick=()=>attempt(()=>show('security-page'));
$('brain-nav').onclick=()=>attempt(async()=>{await show('brain-page');brain.showMenu();});
$('open-security-site').onclick=()=>attempt(()=>openBrowser('https://justzen.co/security.html'));
$('toggle-app-lock').onclick=()=>attempt(async()=>{await call('set-app-lock',{enabled:!securityStatus.lock.enabled,minutes:Number($('auto-lock-minutes').value),passcode:$('new-lock-passcode').value});$('new-lock-passcode').value='';await renderSecurityStatus();notice('App lock setting saved.');});
$('auto-lock-minutes').onchange=()=>attempt(async()=>{if(!securityStatus?.lock.enabled)return;await call('set-app-lock',{enabled:true,minutes:Number($('auto-lock-minutes').value)});await renderSecurityStatus();notice('Automatic lock delay saved.');});
$('sleep-default').onchange=()=>attempt(async()=>{sleep=await call('set-sleep',{defaultMinutes:Number($('sleep-default').value)});await renderSecurityStatus();notice(sleep.defaultMinutes?'Hidden apps sleep after '+SLEEP_LABELS[sleep.defaultMinutes]+'.':'Apps stay awake.');});
$('lock-now').onclick=()=>attempt(()=>call('lock-app'));
$('isolate-all').onclick=()=>attempt(async()=>{if(!confirm('Move every website to its own isolated login profile? You may need to sign in again.'))return;services(await call('isolate-all-services'));await renderSecurityStatus();notice('Every website now has an isolated profile.');});
$('clear-profile').onclick=()=>attempt(async()=>{const raw=$('clear-profile-target').value,parts=raw.split(':'),profile=parts.shift(),key=parts.length?decodeURIComponent(parts.join(':')):'';const label=$('clear-profile-target').selectedOptions[0]?.textContent;if(!confirm('Clear cookies and local website data for '+label+'? This signs those websites out.'))return;await call('clear-profile-data',{profile,key});if(profile===BROWSER_KEY){tabs=await call('tabs');renderTiles();}notice(label+' cleared.');});
$('clear-claude-history').onclick=()=>attempt(async()=>{if(!confirm('Clear the Claude conversations stored by Just Zen? Claude Code may retain its own separate history.'))return;await call('clear-claude-history');notice('Just Zen Claude history cleared.');});
$('erase-hearth').onclick=()=>attempt(async()=>{if(!confirm('Erase Just Zen settings, tasks, browser sessions and saved Claude history from this Mac?'))return;const state=await call('erase-hearth-data');brain.reset();await hydrate(state);notice('All Just Zen data erased.');});
$('unlock-app').onclick=async()=>{try{$('unlock-error').textContent='';const state=await call('unlock-app',$('unlock-passcode').value);await hydrate(state);}catch(error){$('unlock-error').textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,'');}};$('unlock-passcode').onkeydown=e=>{if(e.key==='Enter')$('unlock-app').click();};
$('choose-folder').onclick=()=>attempt(choose);
$('choose-claude-folder').onclick=()=>attempt(chooseClaude);$('claude-login').onclick=()=>attempt(()=>start('login'));$('disconnect-claude').onclick=()=>attempt(async()=>{await call('disconnect-claude-folder');setClaudeAccess({root:null,policy:claudePolicy,workspaces:claudeWorkspaces});notice('Claude is disconnected from local files.');});$('claude-workspace').onchange=()=>attempt(async()=>{if(!$('claude-workspace').value)return;setClaudeAccess(await call('select-claude-folder',$('claude-workspace').value));notice('Switched Claude workspace.');});$('claude-policy').onchange=()=>attempt(async()=>{claudePolicy=await call('set-claude-policy',$('claude-policy').value);setClaudeAccess({root:claudeRoot,policy:claudePolicy,workspaces:claudeWorkspaces});notice('Claude access set to '+$('claude-policy').options[$('claude-policy').selectedIndex].text+'.');});
$('add-app').onclick=()=>attempt(()=>openPicker('installed'));
$('start').onclick=()=>attempt(()=>start('claude'));$('shell').onclick=()=>attempt(()=>start('shell'));
$('stop').onclick=()=>attempt(async()=>{if(mode==='chat'){if(chatState.busy)await call('chat-stop');}else if(running && confirm('Stop this running terminal session?'))await call('stop-terminal');});
$('refresh').onclick=()=>attempt(()=>list(directory));$('save').onclick=()=>attempt(save);$('editor').oninput=()=>{$('save').disabled=!dirty();};
$('note-preview').onclick=()=>setNoteMode('preview');$('note-edit').onclick=()=>setNoteMode('edit');
$('app-search').oninput=()=>{catalogPage=0;renderApps();};$('app-category').onchange=()=>{catalogPage=0;renderApps();};$('apps-prev').onclick=()=>{catalogPage--;renderApps();$('app-list').scrollTop=0;};$('apps-next').onclick=()=>{catalogPage++;renderApps();$('app-list').scrollTop=0;};$('cancel-app').onclick=()=>$('app-dialog').close();$('tab-installed').onclick=()=>pickerTab('installed');$('tab-website').onclick=()=>pickerTab('website');$('tab-group').onclick=()=>pickerTab('group');
$('app-dialog').addEventListener('close',resumeViews);
$('website-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{const raw=$('website-url').value.trim();const url=new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw)?raw:'https://'+raw);const name=$('website-name').value.trim() || url.hostname.replace(/^www\./,'');const items=await call('add-service',{name,url:url.href});services(items);const item=items.find(value=>value.url===url.href);$('app-dialog').close();$('website-form').reset();if(item)await openInTile(item.id || item.url);notice(name+' added. Cookies are saved on this Mac.');});};
$('group-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{const name=$('group-name').value.trim();const icon=$('group-icon').value.trim() || GROUP_ICONS[0];const keys=[...$('group-apps').querySelectorAll('input:checked')].map(box=>box.value);const state=await call('create-service-folder',{name,icon,keys});services(state.services,state.folders);$('app-dialog').close();$('group-form').reset();for(const b of $('group-icons').children)b.setAttribute('aria-pressed','false');notice('Group "'+name+'" added to the sidebar.');});};
$('theme-toggle').onclick=()=>attempt(async()=>{applyTheme(theme==='light'?'dark':'light');await call('appearance',{theme});});
for(const next of ['chat','terminal'])$('mode-'+next).onclick=()=>attempt(async()=>{applyMode(next);await call('appearance',{mode:next});});
$('collapse-agent').onclick=()=>attempt(()=>applyLayout({agentCollapsed:true,centreCollapsed:false}));$('agent-rail').onclick=()=>attempt(()=>applyLayout({agentCollapsed:false}));$('collapse-centre').onclick=()=>attempt(()=>applyLayout({centreCollapsed:true,agentCollapsed:false}));$('restore-centre').onclick=()=>attempt(()=>applyLayout({centreCollapsed:false}));
$('collapse-nav').onclick=()=>attempt(()=>applyLayout({navCollapsed:!layout.navCollapsed}));
$('tasks-rail').onclick=()=>{document.body.classList.add('tasks-open');requestAnimationFrame(()=>{placeViews();$('todo-input').focus();});};$('close-tasks').onclick=()=>{document.body.classList.remove('tasks-open');placeViews();};
$('todo-tab').onclick=()=>{taskTab='todo';renderTodos();};$('done-tab').onclick=()=>{taskTab='done';renderTodos();};$('todo-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{todos=await call('add-todo',$('todo-input').value);$('todo-input').value='';taskTab='todo';renderTodos();});};
window.hearth.on('todos-changed',list=>{todos=list;taskTab='todo';renderTodos();if(!document.body.classList.contains('tasks-open'))$('tasks-rail').click();});
$('chat-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{const prompt=$('chat-input').value;if(!prompt.trim())return;if(!claudeRoot && !await chooseClaude())return;await call('chat-send',prompt);$('chat-input').value='';});};
$('chat-input').onkeydown=e=>{if(e.key==='Enter' && !e.shiftKey && !e.isComposing){e.preventDefault();if(!chatState.busy)$('chat-form').requestSubmit();}};
$('new-chat').onclick=()=>attempt(async()=>{if(chatState.messages.length && !confirm('Start a new conversation? The previous session remains in Claude Code’s history.'))return;await call('chat-new');});
terminal.onData(data=>call('terminal-input',data).catch(e=>notice(e.message)));
window.hearth.on('terminal-data',data=>terminal.write(data));window.hearth.on('notice',notice);window.hearth.on('chat-state',renderChat);
window.hearth.on('terminal-exit',code=>{running=false;const wasLogin=loginInProgress;loginInProgress=false;terminal.reset();if(wasLogin){applyMode('chat');attempt(()=>call('appearance',{mode:'chat'}));notice(code===0?'Signed in to Claude. You can chat now.':'Sign-in did not complete · exit '+code);attempt(refreshClaudeAuth);return;}applyMode(mode);notice('Terminal session ended · exit '+code);});
window.hearth.on('app-locked',setLocked);window.hearth.on('data-erased',()=>notice('All Just Zen data erased.'));
new ResizeObserver(size).observe($('terminal'));
window.addEventListener('beforeunload',e=>{if(dirty() || running || chatState.busy){if(!confirm('Close Just Zen? Unsaved edits and running work will be stopped.')){e.preventDefault();e.returnValue=false;}}});
for(const id of ['markdown-preview','chat-messages'])$(id).addEventListener('click',e=>{const a=e.target.closest('a');if(!a)return;e.preventDefault();const href=a.getAttribute('href');attempt(async()=>{if(href.startsWith('#vault-note=')){const target=decodeURIComponent(href.slice(12)).split('#')[0];await openFile(await call('resolve-note',{target,from:currentFile}));}else if(/^https?:/i.test(href)){await openBrowser(href);}else if(!href.startsWith('#')){const target=decodeURIComponent(href).split('#')[0];await openFile(await call('resolve-note',{target,from:currentFile}));}});});
document.addEventListener('keydown',e=>{if(!e.metaKey)return;if(e.key==='s' && page==='files-page'){e.preventDefault();attempt(save);}if(e.key==='1')attempt(()=>show('overview'));if(e.key==='2')$('vault').click();if(e.key==='3')attempt(()=>show('security-page'));if(e.key.toLowerCase()==='k' && !e.shiftKey && !e.altKey){e.preventDefault();attempt(openPalette);}});
let lastActivity=0;for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>{const now=Date.now();if(now-lastActivity>60_000){lastActivity=now;call('app-activity').catch(()=>{});}},{capture:true});
attempt(async()=>{const state=await call('state');applyTheme(state.theme || 'light');showVersion(state);if(state.locked)setLocked(true,state.lockMethod);else await hydrate(state);});

function documentBounds(){const surface=$('documents-surface'),r=surface.getBoundingClientRect();call('document-bounds',{x:r.x,y:r.y,width:r.width,height:r.height,visible:document.body.classList.contains('documents-open')}).catch(()=>{});}
$('documents-rail').onclick=()=>{document.body.classList.add('documents-open');requestAnimationFrame(()=>{documentBounds();placeViews();size();});};
window.hearth.on('document-collapse',()=>{document.body.classList.remove('documents-open');requestAnimationFrame(()=>{documentBounds();placeViews();size();});});
new ResizeObserver(documentBounds).observe($('documents-surface'));


function renderConnectedFolders(folders){
 $('connected-folders').replaceChildren();
 for(const folder of folders){const button=document.createElement('button');button.className='connected-folder';button.classList.toggle('selected',folder===root);button.textContent='▱ '+pretty(folder);button.title='Use this folder in Files and Claude';button.onclick=()=>attempt(async()=>{if(!discard())return;const state=await call('select-files-folder',folder);setRoot(state.root);renderConnectedFolders(state.connectedFolders);setClaudeAccess({root:state.claudeRoot,policy:state.claudePolicy,workspaces:state.claudeWorkspaces});currentFile=null;original='';directory='';$('editor').value='';$('editor').disabled=true;$('save').disabled=true;$('markdown-preview').textContent='';$('note-tabs').classList.add('hidden');$('filename').textContent='Select a note or source file';await list('');});$('connected-folders').append(button);}
}

// ---- Command palette (⌘K, or ⌘⇧P from anywhere) ----
const palette=$('palette'),paletteInput=$('palette-input'),paletteList=$('palette-list');
let paletteItems=[],paletteIndex=0,paletteSearch=0;
function staticPaletteItems(){
 const items=[];
 items.push({label:'Browser',hint:'Tabs for any website',run:()=>openBrowser()});
 for(const item of sidebarItems)items.push({label:item.name,hint:item.url?new URL(item.url).hostname.replace(/^www\./,''):'App',run:()=>openService(item)});
 for(const folder of serviceFolders)items.push({label:folder.icon+' '+folder.name,hint:'Group',run:()=>{const members=sidebarItems.filter(item=>item.folderId===folder.id);const row=document.querySelector(`.service-group[data-folder="${CSS.escape(folder.id)}"]`);if(row)openMegaMenu(folder,members,row);}});
 items.push({label:'New tab',hint:'In the current app · ⌘T',run:()=>{const slot=page==='browser-page'?focusedSlot():null;return newTab(slot?slot.serviceKey:BROWSER_KEY);}},{label:'One app in the centre',hint:'Layout',run:()=>setTilesMode('1')},{label:'Two apps side by side',hint:'Layout',run:()=>setTilesMode('2h')},{label:'Two apps stacked',hint:'Layout',run:()=>setTilesMode('2v')},{label:'Four apps in a grid',hint:'Layout',run:()=>setTilesMode('4')});
 items.push({label:'Sign in to Claude',hint:'Browser sign-in for Just Zen',run:()=>start('login')},{label:'Sign out of Claude',hint:'Just Zen login only',run:()=>$('claude-logout').click()},{label:'Scribble',hint:'Whiteboard · ⌘1',run:()=>show('overview')},{label:'Files',hint:'Notes and vault · ⌘2',run:()=>$('vault').click()},{label:'Privacy & data',hint:'Build status and controls · ⌘3',run:()=>show('security-page')},{label:'Brain break',hint:'AI Buster puzzles',run:()=>$('brain-nav').click()},{label:'Tasks',hint:'Open the task list',run:()=>$('tasks-rail').click()},{label:'Documents',hint:'Open the document pane',run:()=>$('documents-rail').click()},{label:'Claude Chat',hint:'Talk to Claude',run:async()=>{await applyLayout({agentCollapsed:false});applyMode('chat');$('chat-input').focus();}},{label:'Claude Terminal',hint:'Claude Code in a terminal',run:()=>start('claude')},{label:'Add app or website',hint:'App library',run:()=>openPicker('installed')},{label:'Create a group',hint:'Sidebar groups',run:()=>openPicker('group')});
 for(const todo of todos.filter(t=>!t.done))items.push({label:'Complete task: '+todo.text,hint:'Tasks',run:async()=>{todos=await call('toggle-todo',todo.id);renderTodos();notice('Task completed.');}});
 return items;
}
function dynamicPaletteItems(q){
 if(!q)return [];
 const items=[{label:'Ask Claude: '+q,hint:'Chat',run:async()=>{await applyLayout({agentCollapsed:false});applyMode('chat');$('chat-input').value=q;$('chat-input').focus();}},{label:'New task: '+q,hint:'Tasks',run:async()=>{todos=await call('add-todo',q);renderTodos();notice('Task added.');}}];
 if(/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(q))items.unshift({label:'Open website: '+q,hint:'Browser',run:()=>openBrowser(/^https?:/i.test(q)?q:'https://'+q)});
 return items;
}
function renderPalette(){
 paletteList.replaceChildren();
 if(!paletteItems.length){const p=document.createElement('div');p.className='palette-empty';p.textContent='Nothing matches.';paletteList.append(p);return;}
 paletteIndex=Math.max(0,Math.min(paletteIndex,paletteItems.length-1));
 paletteItems.forEach((item,i)=>{const b=document.createElement('button');b.type='button';b.setAttribute('role','option');b.setAttribute('aria-selected',String(i===paletteIndex));const label=document.createElement('span');label.textContent=item.label;const hint=document.createElement('small');hint.textContent=item.hint || '';b.append(label,hint);b.onmousemove=()=>{if(paletteIndex!==i){paletteIndex=i;renderPalette();}};b.onclick=()=>runPaletteItem(i);paletteList.append(b);});
 paletteList.children[paletteIndex]?.scrollIntoView({block:'nearest'});
}
async function updatePalette(){
 const q=paletteInput.value.trim();const token=++paletteSearch;
 paletteItems=[...rank(staticPaletteItems(),q,q?6:12),...dynamicPaletteItems(q)];paletteIndex=0;renderPalette();
 if(root && q.length>=2){const notes=await call('search-notes',q).catch(()=>[]);if(token!==paletteSearch)return;const noteItems=notes.map(path=>({label:'Open note: '+path,hint:'Files',run:async()=>{await show('files-page');await openFile(path);}}));paletteItems=[...paletteItems.filter(i=>!i.label.startsWith('Ask Claude') && !i.label.startsWith('New task')),...noteItems,...paletteItems.filter(i=>i.label.startsWith('Ask Claude') || i.label.startsWith('New task'))];renderPalette();}
}
async function runPaletteItem(i){const item=paletteItems[i];if(!item)return;palette.close();await attempt(()=>item.run());}
async function openPalette(){
 if(document.body.classList.contains('is-locked') || palette.open)return;
 closePopovers();suspendViews();
 paletteInput.value='';palette.showModal();await updatePalette();paletteInput.focus();
}
palette.addEventListener('close',resumeViews);
palette.addEventListener('click',e=>{if(e.target===palette)palette.close();});
paletteInput.oninput=()=>attempt(updatePalette);
paletteInput.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();paletteIndex=Math.min(paletteIndex+1,paletteItems.length-1);renderPalette();}else if(e.key==='ArrowUp'){e.preventDefault();paletteIndex=Math.max(paletteIndex-1,0);renderPalette();}else if(e.key==='Enter'){e.preventDefault();runPaletteItem(paletteIndex);}};
window.hearth.on('open-palette',()=>attempt(openPalette));
window.hearth.on('update-ready',version=>{$('restart-update').classList.remove('hidden');$('restart-update').textContent='Restart to update to '+version;});
$('restart-update').onclick=()=>attempt(async()=>{if(dirty() && !confirm('Save your note first? Unsaved edits will be lost when the app restarts.'))return;await call('install-update');});
$('jump').onclick=()=>attempt(openPalette);

// ---- Send this to Claude (⌘⇧A) or to Tasks (⌘⇧T) ----
let claudeContext=null;
function currentSelection(){
 const el=document.activeElement;
 if(el && el.tagName==='TEXTAREA'){const t=el.value.slice(el.selectionStart,el.selectionEnd);if(t.trim())return {text:t,source:el.id==='editor'?'your note':'the composer'};}
 if(mode==='terminal' && running){const t=terminal.getSelection();if(t.trim())return {text:t,source:'the terminal'};}
 const t=String(window.getSelection?.() || '');if(t.trim())return {text:t,source:'the page'};
 return null;
}
function showClaudeContext(context){
 claudeContext={text:String(context.text).slice(0,20000),source:context.source || 'your selection'};
 $('chat-context-title').textContent='Selected text from '+claudeContext.source+' · '+claudeContext.text.length.toLocaleString()+' characters';
 $('chat-context-preview').textContent=claudeContext.text.slice(0,400);
 $('chat-context').classList.remove('hidden');
 attempt(async()=>{await applyLayout({agentCollapsed:false});applyMode('chat');});
}
function clearClaudeContext(){claudeContext=null;$('chat-context').classList.add('hidden');}
async function sendClaudeContext(instruction){
 if(!claudeContext)return;const {text,source}=claudeContext;
 if(!claudeRoot && !await chooseClaude())return;
 await call('chat-send',instruction+'\n\nThe text below came from '+source+'.\n\n"""\n'+text+'\n"""');clearClaudeContext();
}
window.hearth.on('capture-selection',payload=>{const target=payload && typeof payload==='object'?payload.target:'claude';const found=currentSelection();if(!found){notice('Select some text first, then press '+(target==='task'?'⌘⇧T.':'⌘⇧A.'));return;}if(target==='task'){attempt(async()=>{todos=await call('add-todo',found.text.replace(/\s+/g,' ').trim().slice(0,300));taskTab='todo';renderTodos();if(!document.body.classList.contains('tasks-open'))$('tasks-rail').click();notice('Added to your tasks.');});return;}showClaudeContext(found);});
window.hearth.on('claude-context',context=>{if(context && typeof context.text==='string')showClaudeContext(context);});
for(const b of document.querySelectorAll('#chat-context [data-instruction]'))b.onclick=()=>attempt(()=>sendClaudeContext(b.dataset.instruction));
$('chat-context-ask').onclick=()=>{if(!claudeContext)return;const {text,source}=claudeContext;$('chat-input').value='\n\nThe text below came from '+source+'.\n\n"""\n'+text+'\n"""';$('chat-input').setSelectionRange(0,0);$('chat-input').focus();clearClaudeContext();};
$('chat-context-discard').onclick=clearClaudeContext;
