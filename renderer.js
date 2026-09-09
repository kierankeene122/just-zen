import {marked} from './node_modules/marked/lib/marked.esm.js';
import {createWhiteboard} from './whiteboard.js';
import {rank} from './palette-match.mjs';
const $=id=>document.getElementById(id);
let homeDir='';const pretty=value=>value && homeDir && value.startsWith(homeDir)?'~'+value.slice(homeDir.length):value;
const call=(name,...args)=>window.hearth.call(name,...args);
let root,claudeRoot=null,claudePolicy='full',claudeWorkspaces=[],currentFile,original='',directory='',page='overview',running=false,mode='chat',theme='light';
let layout={agentCollapsed:false,centreCollapsed:false,navCollapsed:true},catalog=[],catalogPage=0,noteMode='preview';
let serviceFolders=[],todos=[],taskTab='todo';
let chatState={messages:[],busy:false,pending:[]};
let securityLoading=false,securityStatus=null;
const terminal=new Terminal({fontFamily:'Menlo, monospace',fontSize:12,lineHeight:1.25,cursorBlink:true,scrollback:5000});
const fit=new FitAddon.FitAddon();terminal.loadAddon(fit);terminal.open($('terminal'));
const whiteboard=createWhiteboard({save:value=>call('save-whiteboard',value),notice});
function notice(text){$('status').textContent=text;}
async function attempt(fn){try{return await fn();}catch(e){notice(e.message.replace(/^Error invoking remote method '[^']+': Error: /,''));}}
function dirty(){return currentFile && $('editor').value!==original;}
function discard(){return !dirty() || confirm('Discard unsaved changes to this file?');}
function markdown(text){return DOMPurify.sanitize(marked.parse(text,{gfm:true}),{FORBID_TAGS:['img','iframe','form','input','button','style'],FORBID_ATTR:['style']});}

function applyTheme(value){theme=value;document.body.dataset.theme=value;$('theme-toggle').textContent=value==='light'?'☾ Dark':'☀ Light';$('theme-toggle').setAttribute('aria-label',value==='light'?'Switch to dark mode':'Switch to light mode');terminal.options.theme=value==='light'?{background:'#fbfcfe',foreground:'#354258',cursor:'#5278c8',selectionBackground:'#e6eefc'}:{background:'#151816',foreground:'#d5ddcc',cursor:'#c4d3ab',selectionBackground:'#424e36'};}
function size(){if(!running || mode!=='terminal' || layout.agentCollapsed)return;fit.fit();call('terminal-size',{cols:terminal.cols,rows:terminal.rows}).catch(()=>{});}
function browserSize(){if(page!=='browser-page' || layout.centreCollapsed)return;const r=$('browser-surface').getBoundingClientRect();call('browser-bounds',{x:r.x,y:r.y,width:r.width,height:r.height}).catch(()=>{});}
async function applyLayout(next,persist=true){layout={...layout,...next};if(layout.centreCollapsed)layout.agentCollapsed=false;document.body.classList.toggle('agent-collapsed',layout.agentCollapsed);document.body.classList.toggle('centre-collapsed',layout.centreCollapsed);document.body.classList.toggle('nav-collapsed',layout.navCollapsed);$('collapse-nav').textContent=layout.navCollapsed?'›':'‹';$('collapse-nav').setAttribute('aria-label',layout.navCollapsed?'Expand sidebar':'Collapse sidebar');$('agent-rail').classList.toggle('hidden',!layout.agentCollapsed);$('restore-centre').classList.toggle('hidden',!layout.centreCollapsed);if(layout.centreCollapsed)await call('hide-browser');else if(page==='browser-page'){browserSize();await call('show-browser');}size();if(persist)await call('appearance',{layout});}
function applyMode(next){mode=next;$('mode-chat').setAttribute('aria-pressed',next==='chat');$('mode-terminal').setAttribute('aria-pressed',next==='terminal');$('chat-view').classList.toggle('hidden',next!=='chat');$('agent-empty').classList.toggle('hidden',next!=='terminal' || running);$('terminal').classList.toggle('hidden',next!=='terminal' || !running);updateAgentStatus();size();}
function updateAgentStatus(){const state=mode==='chat'?(chatState.busy?(chatState.pending.length?'Needs your approval':'Working…'):'Chat · Claude Code'):(running?'Terminal · running':'Terminal · ready');$('agent-state').textContent=state;$('rail-state').textContent=chatState.pending.length?'●':chatState.busy || running?'·':'';}
async function show(next,activatingApp=false){page=next;if(layout.centreCollapsed)await applyLayout({centreCollapsed:false});if(!activatingApp)await call('hide-browser');['overview','files-page','browser-page','security-page'].forEach(id=>$(id).classList.toggle('hidden',id!==next));$('home').classList.toggle('selected',next==='overview');$('vault').classList.toggle('selected',next==='files-page');$('security-nav').classList.toggle('selected',next==='security-page');if(next==='browser-page'){browserSize();if(!activatingApp)await call('show-browser');}if(next==='security-page')await renderSecurityStatus();}
async function renderSecurityStatus(){if(securityLoading)return;securityLoading=true;try{const status=securityStatus=await call('security-status');$('security-signature').textContent=status.signature;$('security-gatekeeper').textContent=status.gatekeeper;$('security-updates').textContent=status.updates;$('security-engine').textContent='Electron '+status.electron+' · Chromium '+status.chromium;$('security-engine').title=status.engineSupport || '';$('security-engine-support').textContent=status.engineSupport || '';const p=status.profiles,c=status.claude,l=status.lock;$('security-profile-summary').textContent=`${status.encrypted?'Keychain-encrypted state':'Encryption unavailable'} · ${p.shared} Shared · ${p.personal} Personal · ${p.work} Work · ${p.isolated} Isolated · Claude Chat: ${c.sandboxed?'OS sandbox active':'not sandboxed'}.`;$('lock-description').textContent=l.enabled?`${l.method==='passcode'?'Passcode':'Touch ID'} lock is enabled and activates after ${l.minutes} minutes of inactivity.`:l.touchID?'Local state is encrypted. Enable Touch ID to lock the visible workspace after inactivity.':'Touch ID is unavailable. Choose a passcode of at least six characters; local state remains Keychain-encrypted.';$('auto-lock-minutes').value=String(l.minutes);$('auto-lock-minutes').disabled=false;$('new-lock-passcode').classList.toggle('hidden',l.touchID || l.enabled);$('toggle-app-lock').disabled=false;$('toggle-app-lock').textContent=l.enabled?'Disable app lock':l.touchID?'Enable Touch ID lock':'Enable passcode lock';$('lock-now').disabled=!l.enabled;const target=$('clear-profile-target'),selected=target.value;target.replaceChildren(new Option('Shared login group','shared'),new Option('Personal login group','personal'),new Option('Work login group','work'));for(const item of sidebarItems.filter(item=>item.url && (item.profile || 'isolated')==='isolated'))target.add(new Option('Isolated · '+item.name,'isolated:'+encodeURIComponent(item.id || item.url)));if([...target.options].some(option=>option.value===selected))target.value=selected;}finally{securityLoading=false;}}
function setLocked(value,method){if(typeof value==='object'){method=value.method;value=value.locked;}document.body.classList.toggle('is-locked',value);$('lock-screen').classList.toggle('hidden',!value);if(value){const passcode=method==='passcode';$('unlock-passcode').classList.toggle('hidden',!passcode);$('lock-screen-copy').textContent=passcode?'Enter your Just Zen passcode to restore this workspace.':'Use Touch ID to restore your workspace.';$('unlock-app').textContent=passcode?'Unlock':'Unlock with Touch ID';(passcode?$('unlock-passcode'):$('unlock-app')).focus();}else $('unlock-passcode').value='';}
function showVersion(state){if(state?.version)$('app-version').textContent='JUST ZEN · '+state.version;}
function hydrate(state){homeDir=state.home || homeDir;showVersion(state);attempt(refreshClaudeAuth);serviceBadges.clear();for(const [key,count] of Object.entries(state.serviceBadges || {}))serviceBadges.set(key,count);setLocked(false);setRoot(state.root);renderConnectedFolders(state.connectedFolders || []);setClaudeAccess({root:state.claudeRoot,policy:state.claudePolicy,workspaces:state.claudeWorkspaces});services(state.services,state.serviceFolders);todos=state.todos;whiteboard.setBoard(state.whiteboard);renderTodos();applyTheme(state.theme);renderChat(state.chat);applyMode(state.mode);return applyLayout({...state.layout,navCollapsed:layout.navCollapsed},false);}
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
async function browse(url,force=false,saved=false,serviceKey=null){$('browser-page').classList.toggle('saved-app',saved);$('browser-placeholder').textContent='Opening '+new URL(url).hostname+'…';await show('browser-page',true);$('url').value=url;await call('browse',{url,force,serviceKey});}
let sidebarItems=[],dragKey=null;const serviceBadges=new Map();
function paintIcon(img,icon){if(icon){img.src=icon;img.hidden=false;img.nextElementSibling.hidden=true;}}
function serviceRow(item){
 const key=item.id || item.url;const row=document.createElement('div');row.className='service-row';row.draggable=true;
 row.ondragstart=e=>{dragKey=key;e.dataTransfer.setData('text/plain',key);e.dataTransfer.effectAllowed='move';row.classList.add('dragging');};
 row.ondragend=()=>{dragKey=null;document.querySelectorAll('.service-row').forEach(r=>r.classList.remove('dragging','drop-target'));};
 row.ondragover=e=>{if(dragKey && dragKey!==key){e.preventDefault();row.classList.add('drop-target');}};row.ondragleave=()=>row.classList.remove('drop-target');
 row.ondrop=e=>{e.preventDefault();e.stopPropagation();row.classList.remove('drop-target');if(!dragKey || dragKey===key)return;const keys=sidebarItems.map(s=>s.id || s.url);const source=keys.indexOf(dragKey),target=keys.indexOf(key);keys.splice(source,1);keys.splice(target,0,dragKey);attempt(async()=>{services(await call('reorder-services',keys));notice('Sidebar order saved.');});};
 const grip=document.createElement('button');grip.className='reorder-handle';grip.textContent='⠿';grip.title='Drag to reorder. Use Option + ↑ or ↓ to move.';grip.setAttribute('aria-label','Reorder '+item.name);grip.onkeydown=e=>{if(!e.altKey || !['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const keys=sidebarItems.map(s=>s.id || s.url),i=keys.indexOf(key),next=i+(e.key==='ArrowUp'?-1:1);if(next<0 || next>=keys.length)return;[keys[i],keys[next]]=[keys[next],keys[i]];attempt(async()=>{services(await call('reorder-services',keys));$('services').children[next].querySelector('.reorder-handle').focus();notice(item.name+' moved '+(next<i?'up':'down'));});};
 const b=document.createElement('button');b.className='nav';const img=document.createElement('img');img.className='site-favicon';img.alt='';img.hidden=true;img.dataset.site=item.url || '';const fallback=document.createElement('span');fallback.className='site-fallback';fallback.textContent=item.name.slice(0,1).toUpperCase();const label=document.createElement('span');label.textContent=item.name;const badge=document.createElement('small');badge.className='service-badge';badge.dataset.badgeKey=key;const count=serviceBadges.get(key) || 0;badge.textContent=count>99?'99+':String(count || '');badge.hidden=!count;b.append(img,fallback,label,badge);b.onclick=()=>attempt(()=>openService(item));
 const profile=document.createElement('select');profile.className='service-profile';profile.title='Browser profile for '+item.name;profile.setAttribute('aria-label','Browser profile for '+item.name);for(const [value,label] of [['isolated','Isolated'],['shared','Shared'],['personal','Personal'],['work','Work']])profile.add(new Option(label,value));profile.value=item.profile || 'isolated';profile.onclick=e=>e.stopPropagation();profile.onchange=()=>attempt(async()=>{services(await call('set-service-profile',{key,profile:profile.value}));notice(item.name+' now uses the '+profile.options[profile.selectedIndex].text+' profile. Sign in within that profile if needed.');});
 const remove=document.createElement('button');remove.className='remove-service';remove.textContent='×';remove.title='Remove '+item.name;remove.setAttribute('aria-label','Remove '+item.name);remove.onclick=()=>attempt(async()=>{services(await call('remove-service',key));notice(item.name+' removed from the sidebar.');});row.append(grip,b);if(item.url)row.append(profile);row.append(remove);
 if(item.url)call('favicon',key).then(icon=>paintIcon(img,icon)).catch(()=>{});
 return row;
}
function services(items,folders=serviceFolders){sidebarItems=items;serviceFolders=folders;$('services').replaceChildren();$('services').ondragover=e=>{if(dragKey && !e.target.closest('.service-folder'))e.preventDefault();};$('services').ondrop=e=>{if(!dragKey || e.target.closest('.service-folder'))return;e.preventDefault();attempt(async()=>{const state=await call('set-service-folder',{key:dragKey,folderId:null});services(state.services,state.folders);notice('Moved out of folder.');});};
 const groups=[{id:null,name:'',collapsed:false},...folders];
 for(const folder of groups){const grouped=items.filter(item=>(item.folderId || null)===folder.id);if(folder.id){const section=document.createElement('section');section.className='service-folder';section.dataset.folder=folder.id;const heading=document.createElement('button');heading.className='folder-heading';heading.innerHTML='<span>'+(folder.collapsed?'▸':'▾')+'</span><b></b><small></small>';heading.querySelector('b').textContent=folder.name;heading.querySelector('small').textContent=grouped.length;heading.onclick=()=>attempt(async()=>{const state=await call('toggle-service-folder',folder.id);services(state.services,state.folders);});section.append(heading);section.ondragover=e=>{if(dragKey)e.preventDefault();};section.ondrop=e=>{e.preventDefault();if(!dragKey)return;attempt(async()=>{const state=await call('set-service-folder',{key:dragKey,folderId:folder.id});services(state.services,state.folders);notice('Moved into '+folder.name);});};if(!folder.collapsed)for(const item of grouped)section.append(serviceRow(item));$('services').append(section);}else for(const item of grouped)$('services').append(serviceRow(item));}
}
window.hearth.on('favicon',({url,icon})=>{for(const img of document.querySelectorAll('.site-favicon'))if(img.dataset.site===url)paintIcon(img,icon);});
window.hearth.on('service-badge',({key,count})=>{if(count)serviceBadges.set(key,count);else serviceBadges.delete(key);const badge=document.querySelector(`[data-badge-key="${CSS.escape(key)}"]`);if(badge){badge.textContent=count>99?'99+':String(count || '');badge.hidden=!count;}});
window.hearth.on('open-service',key=>{const item=sidebarItems.find(value=>(value.id || value.url)===key);if(item)attempt(()=>openService(item));});

function renderTodos(){const done=taskTab==='done';$('todo-tab').setAttribute('aria-pressed',!done);$('done-tab').setAttribute('aria-pressed',done);$('todo-form').classList.toggle('hidden',done);$('todo-list').replaceChildren();const list=todos.filter(todo=>todo.done===done);$('task-count').textContent=todos.filter(todo=>!todo.done).length || '';for(const todo of list){const row=document.createElement('label');row.className='todo-row';const box=document.createElement('input');box.type='checkbox';box.checked=todo.done;box.onchange=()=>attempt(async()=>{todos=await call('toggle-todo',todo.id);renderTodos();});const text=document.createElement('span');text.textContent=todo.text;row.append(box,text);$('todo-list').append(row);}if(!list.length){const empty=document.createElement('p');empty.className='todo-empty';empty.textContent=done?'Completed tasks will appear here.':'Nothing waiting. A clear list is a good list.';$('todo-list').append(empty);}}
async function openService(item){if(item.kind==='claude'){await applyLayout({agentCollapsed:false});if(mode==='terminal'){if(!running)await start('claude');terminal.focus();}else $('chat-input').focus();return;}if(item.kind==='vault'){if(!root){await choose();return;}await show('files-page');await list(directory);return;}await browse(item.url,false,true,item.id || item.url);}
function pickerTab(which){const installed=which==='installed';$('installed-panel').classList.toggle('hidden',!installed);$('website-form').classList.toggle('hidden',installed);$('tab-installed').setAttribute('aria-pressed',installed);$('tab-website').setAttribute('aria-pressed',!installed);if(!installed)$('website-url').focus();}
async function openPicker(){
  await call('hide-browser');$('app-dialog').showModal();pickerTab('installed');$('app-search').value='';$('app-category').value='';catalogPage=0;$('app-list').textContent='Loading the app library…';catalog=await call('web-apps');
  $('app-category').replaceChildren(new Option('All categories',''));for(const category of [...new Set(catalog.map(a=>a.category))].sort())$('app-category').add(new Option(category,category));renderApps();$('app-search').focus();
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
$('open-security-site').onclick=()=>attempt(()=>browse('https://justzen.co/security.html'));
$('toggle-app-lock').onclick=()=>attempt(async()=>{await call('set-app-lock',{enabled:!securityStatus.lock.enabled,minutes:Number($('auto-lock-minutes').value),passcode:$('new-lock-passcode').value});$('new-lock-passcode').value='';await renderSecurityStatus();notice('App lock setting saved.');});
$('auto-lock-minutes').onchange=()=>attempt(async()=>{if(!securityStatus?.lock.enabled)return;await call('set-app-lock',{enabled:true,minutes:Number($('auto-lock-minutes').value)});await renderSecurityStatus();notice('Automatic lock delay saved.');});
$('lock-now').onclick=()=>attempt(()=>call('lock-app'));
$('isolate-all').onclick=()=>attempt(async()=>{if(!confirm('Move every website to its own isolated login profile? You may need to sign in again.'))return;services(await call('isolate-all-services'));await renderSecurityStatus();notice('Every website now has an isolated profile.');});
$('clear-profile').onclick=()=>attempt(async()=>{const raw=$('clear-profile-target').value,parts=raw.split(':'),profile=parts.shift(),key=parts.length?decodeURIComponent(parts.join(':')):'';const label=$('clear-profile-target').selectedOptions[0]?.textContent;if(!confirm('Clear cookies and local website data for '+label+'? This signs those websites out.'))return;await call('clear-profile-data',{profile,key});notice(label+' cleared.');});
$('clear-claude-history').onclick=()=>attempt(async()=>{if(!confirm('Clear the Claude conversations stored by Just Zen? Claude Code may retain its own separate history.'))return;await call('clear-claude-history');notice('Just Zen Claude history cleared.');});
$('erase-hearth').onclick=()=>attempt(async()=>{if(!confirm('Erase Just Zen settings, tasks, browser sessions and saved Claude history from this Mac?'))return;const state=await call('erase-hearth-data');await hydrate(state);notice('All Just Zen data erased.');});
$('unlock-app').onclick=async()=>{try{$('unlock-error').textContent='';const state=await call('unlock-app',$('unlock-passcode').value);await hydrate(state);}catch(error){$('unlock-error').textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,'');}};$('unlock-passcode').onkeydown=e=>{if(e.key==='Enter')$('unlock-app').click();};
$('choose-folder').onclick=()=>attempt(choose);
$('choose-claude-folder').onclick=()=>attempt(chooseClaude);$('claude-login').onclick=()=>attempt(()=>start('login'));$('disconnect-claude').onclick=()=>attempt(async()=>{await call('disconnect-claude-folder');setClaudeAccess({root:null,policy:claudePolicy,workspaces:claudeWorkspaces});notice('Claude is disconnected from local files.');});$('claude-workspace').onchange=()=>attempt(async()=>{if(!$('claude-workspace').value)return;setClaudeAccess(await call('select-claude-folder',$('claude-workspace').value));notice('Switched Claude workspace.');});$('claude-policy').onchange=()=>attempt(async()=>{claudePolicy=await call('set-claude-policy',$('claude-policy').value);setClaudeAccess({root:claudeRoot,policy:claudePolicy,workspaces:claudeWorkspaces});notice('Claude access set to '+$('claude-policy').options[$('claude-policy').selectedIndex].text+'.');});
$('add-app').onclick=()=>attempt(openPicker);
$('start').onclick=()=>attempt(()=>start('claude'));$('shell').onclick=()=>attempt(()=>start('shell'));
$('stop').onclick=()=>attempt(async()=>{if(mode==='chat'){if(chatState.busy)await call('chat-stop');}else if(running && confirm('Stop this running terminal session?'))await call('stop-terminal');});
$('refresh').onclick=()=>attempt(()=>list(directory));$('save').onclick=()=>attempt(save);$('editor').oninput=()=>{$('save').disabled=!dirty();};
$('note-preview').onclick=()=>setNoteMode('preview');$('note-edit').onclick=()=>setNoteMode('edit');
$('url-form').onsubmit=e=>{e.preventDefault();attempt(()=>browse($('url').value,true));};
$('app-search').oninput=()=>{catalogPage=0;renderApps();};$('app-category').onchange=()=>{catalogPage=0;renderApps();};$('apps-prev').onclick=()=>{catalogPage--;renderApps();$('app-list').scrollTop=0;};$('apps-next').onclick=()=>{catalogPage++;renderApps();$('app-list').scrollTop=0;};$('cancel-app').onclick=()=>$('app-dialog').close();$('tab-installed').onclick=()=>pickerTab('installed');$('tab-website').onclick=()=>pickerTab('website');
$('app-dialog').addEventListener('close',()=>{if(page==='browser-page' && !layout.centreCollapsed)attempt(()=>call('show-browser'));});
$('website-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{const raw=$('website-url').value.trim();const url=new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw)?raw:'https://'+raw);const name=$('website-name').value.trim() || url.hostname.replace(/^www\./,'');const items=await call('add-service',{name,url:url.href});services(items);const item=items.find(value=>value.url===url.href);$('app-dialog').close();$('website-form').reset();await browse(url.href,false,true,item?.id || item?.url);notice(name+' added. Cookies are saved on this Mac.');});};
$('theme-toggle').onclick=()=>attempt(async()=>{applyTheme(theme==='light'?'dark':'light');await call('appearance',{theme});});
for(const next of ['chat','terminal'])$('mode-'+next).onclick=()=>attempt(async()=>{applyMode(next);await call('appearance',{mode:next});});
$('collapse-agent').onclick=()=>attempt(()=>applyLayout({agentCollapsed:true,centreCollapsed:false}));$('agent-rail').onclick=()=>attempt(()=>applyLayout({agentCollapsed:false}));$('collapse-centre').onclick=()=>attempt(()=>applyLayout({centreCollapsed:true,agentCollapsed:false}));$('restore-centre').onclick=()=>attempt(()=>applyLayout({centreCollapsed:false}));
$('collapse-nav').onclick=()=>attempt(()=>applyLayout({navCollapsed:!layout.navCollapsed}));
$('tasks-rail').onclick=()=>{document.body.classList.add('tasks-open');requestAnimationFrame(()=>{browserSize();$('todo-input').focus();});};$('close-tasks').onclick=()=>{document.body.classList.remove('tasks-open');requestAnimationFrame(browserSize);};
$('todo-tab').onclick=()=>{taskTab='todo';renderTodos();};$('done-tab').onclick=()=>{taskTab='done';renderTodos();};$('todo-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{todos=await call('add-todo',$('todo-input').value);$('todo-input').value='';taskTab='todo';renderTodos();});};
$('chat-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{const prompt=$('chat-input').value;if(!prompt.trim())return;if(!claudeRoot && !await chooseClaude())return;await call('chat-send',prompt);$('chat-input').value='';});};
$('chat-input').onkeydown=e=>{if(e.key==='Enter' && !e.shiftKey && !e.isComposing){e.preventDefault();if(!chatState.busy)$('chat-form').requestSubmit();}};
$('new-chat').onclick=()=>attempt(async()=>{if(chatState.messages.length && !confirm('Start a new conversation? The previous session remains in Claude Code’s history.'))return;await call('chat-new');});
terminal.onData(data=>call('terminal-input',data).catch(e=>notice(e.message)));
window.hearth.on('terminal-data',data=>terminal.write(data));window.hearth.on('notice',notice);window.hearth.on('browser-url',url=>{$('url').value=url;});window.hearth.on('chat-state',renderChat);
window.hearth.on('terminal-exit',code=>{running=false;const wasLogin=loginInProgress;loginInProgress=false;terminal.reset();if(wasLogin){applyMode('chat');attempt(()=>call('appearance',{mode:'chat'}));notice(code===0?'Signed in to Claude. You can chat now.':'Sign-in did not complete · exit '+code);attempt(refreshClaudeAuth);return;}applyMode(mode);notice('Terminal session ended · exit '+code);});
window.hearth.on('app-locked',setLocked);window.hearth.on('data-erased',()=>notice('All Just Zen data erased.'));
new ResizeObserver(size).observe($('terminal'));new ResizeObserver(browserSize).observe($('browser-surface'));
window.addEventListener('beforeunload',e=>{if(dirty() || running || chatState.busy){if(!confirm('Close Just Zen? Unsaved edits and running work will be stopped.')){e.preventDefault();e.returnValue=false;}}});
for(const id of ['markdown-preview','chat-messages'])$(id).addEventListener('click',e=>{const a=e.target.closest('a');if(!a)return;e.preventDefault();const href=a.getAttribute('href');attempt(async()=>{if(href.startsWith('#vault-note=')){const target=decodeURIComponent(href.slice(12)).split('#')[0];await openFile(await call('resolve-note',{target,from:currentFile}));}else if(/^https?:/i.test(href)){await browse(href);}else if(!href.startsWith('#')){const target=decodeURIComponent(href).split('#')[0];await openFile(await call('resolve-note',{target,from:currentFile}));}});});
document.addEventListener('keydown',e=>{if(!e.metaKey)return;if(e.key==='s' && page==='files-page'){e.preventDefault();attempt(save);}if(e.key==='1')attempt(()=>show('overview'));if(e.key==='2')$('vault').click();if(e.key==='3')attempt(()=>show('security-page'));if(e.key.toLowerCase()==='k' && !e.shiftKey && !e.altKey){e.preventDefault();attempt(openPalette);}});
let lastActivity=0;for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>{const now=Date.now();if(now-lastActivity>60_000){lastActivity=now;call('app-activity').catch(()=>{});}},{capture:true});
attempt(async()=>{const state=await call('state');applyTheme(state.theme || 'light');showVersion(state);if(state.locked)setLocked(true,state.lockMethod);else await hydrate(state);});

function documentBounds(){const surface=$('documents-surface'),r=surface.getBoundingClientRect();call('document-bounds',{x:r.x,y:r.y,width:r.width,height:r.height,visible:document.body.classList.contains('documents-open')}).catch(()=>{});}
$('documents-rail').onclick=()=>{document.body.classList.add('documents-open');requestAnimationFrame(()=>{documentBounds();browserSize();size();});};
window.hearth.on('document-collapse',()=>{document.body.classList.remove('documents-open');requestAnimationFrame(()=>{documentBounds();browserSize();size();});});
new ResizeObserver(documentBounds).observe($('documents-surface'));


function renderConnectedFolders(folders){
 $('connected-folders').replaceChildren();
 for(const folder of folders){const button=document.createElement('button');button.className='connected-folder';button.classList.toggle('selected',folder===root);button.textContent='▱ '+pretty(folder);button.title='Use this folder in Files and Claude';button.onclick=()=>attempt(async()=>{if(!discard())return;const state=await call('select-files-folder',folder);setRoot(state.root);renderConnectedFolders(state.connectedFolders);setClaudeAccess({root:state.claudeRoot,policy:state.claudePolicy,workspaces:state.claudeWorkspaces});currentFile=null;original='';directory='';$('editor').value='';$('editor').disabled=true;$('save').disabled=true;$('markdown-preview').textContent='';$('note-tabs').classList.add('hidden');$('filename').textContent='Select a note or source file';await list('');});$('connected-folders').append(button);}
}

// ---- Command palette (⌘K, or ⌘⇧P from anywhere) ----
const palette=$('palette'),paletteInput=$('palette-input'),paletteList=$('palette-list');
let paletteItems=[],paletteIndex=0,paletteHidBrowser=false,paletteSearch=0;
function staticPaletteItems(){
 const items=[];
 for(const item of sidebarItems)items.push({label:item.name,hint:item.url?new URL(item.url).hostname.replace(/^www\./,''):'App',run:()=>openService(item)});
 items.push({label:'Sign in to Claude',hint:'Browser sign-in for Just Zen',run:()=>start('login')},{label:'Sign out of Claude',hint:'Just Zen login only',run:()=>$('claude-logout').click()},{label:'Scribble',hint:'Whiteboard · ⌘1',run:()=>show('overview')},{label:'Files',hint:'Notes and vault · ⌘2',run:()=>$('vault').click()},{label:'Privacy & data',hint:'Build status and controls · ⌘3',run:()=>show('security-page')},{label:'Tasks',hint:'Open the task list',run:()=>$('tasks-rail').click()},{label:'Documents',hint:'Open the document pane',run:()=>$('documents-rail').click()},{label:'Claude Chat',hint:'Talk to Claude',run:async()=>{await applyLayout({agentCollapsed:false});applyMode('chat');$('chat-input').focus();}},{label:'Claude Terminal',hint:'Claude Code in a terminal',run:()=>start('claude')},{label:'Add app or website',hint:'App library',run:openPicker});
 for(const todo of todos.filter(t=>!t.done))items.push({label:'Complete task: '+todo.text,hint:'Tasks',run:async()=>{todos=await call('toggle-todo',todo.id);renderTodos();notice('Task completed.');}});
 return items;
}
function dynamicPaletteItems(q){
 if(!q)return [];
 const items=[{label:'Ask Claude: '+q,hint:'Chat',run:async()=>{await applyLayout({agentCollapsed:false});applyMode('chat');$('chat-input').value=q;$('chat-input').focus();}},{label:'New task: '+q,hint:'Tasks',run:async()=>{todos=await call('add-todo',q);renderTodos();notice('Task added.');}}];
 if(/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(q))items.unshift({label:'Open website: '+q,hint:'Browser',run:()=>browse(/^https?:/i.test(q)?q:'https://'+q,true)});
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
 paletteHidBrowser=page==='browser-page' && !layout.centreCollapsed;if(paletteHidBrowser)await call('hide-browser');
 paletteInput.value='';palette.showModal();await updatePalette();paletteInput.focus();
}
palette.addEventListener('close',()=>{if(paletteHidBrowser){paletteHidBrowser=false;attempt(()=>call('show-browser'));}});
palette.addEventListener('click',e=>{if(e.target===palette)palette.close();});
paletteInput.oninput=()=>attempt(updatePalette);
paletteInput.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();paletteIndex=Math.min(paletteIndex+1,paletteItems.length-1);renderPalette();}else if(e.key==='ArrowUp'){e.preventDefault();paletteIndex=Math.max(paletteIndex-1,0);renderPalette();}else if(e.key==='Enter'){e.preventDefault();runPaletteItem(paletteIndex);}};
window.hearth.on('open-palette',()=>attempt(openPalette));
$('jump').onclick=()=>attempt(openPalette);

// ---- Send this to Claude (⌘⇧A) ----
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
window.hearth.on('capture-selection',()=>{const found=currentSelection();if(!found){notice('Select some text first, then press ⌘⇧A.');return;}showClaudeContext(found);});
window.hearth.on('claude-context',context=>{if(context && typeof context.text==='string')showClaudeContext(context);});
for(const b of document.querySelectorAll('#chat-context [data-instruction]'))b.onclick=()=>attempt(()=>sendClaudeContext(b.dataset.instruction));
$('chat-context-ask').onclick=()=>{if(!claudeContext)return;const {text,source}=claudeContext;$('chat-input').value='\n\nThe text below came from '+source+'.\n\n"""\n'+text+'\n"""';$('chat-input').setSelectionRange(0,0);$('chat-input').focus();clearClaudeContext();};
$('chat-context-discard').onclick=clearClaudeContext;
