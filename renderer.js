import {marked} from './node_modules/marked/lib/marked.esm.js';
const $=id=>document.getElementById(id);
let homeDir='';const pretty=value=>value && homeDir && value.startsWith(homeDir)?'~'+value.slice(homeDir.length):value;
const call=(name,...args)=>window.hearth.call(name,...args);
// Just Zen is a menu-bar app: the panel and ⌥Space live outside this window, which holds Claude, your notes, your tasks and the settings.
let root=null,claudeRoot=null,claudePolicy='notes',claudeWorkspaces=[],running=false,mode='chat',theme='light';
let layout={agentCollapsed:false};
let todos=[],taskTab='todo',taskFolders=[],taskTarget=null,platform='darwin';
let chatState={messages:[],busy:false,pending:[]};
let claudeContext=null,composerFrom=null,loginInProgress=false;
const terminal=new Terminal({fontFamily:'Menlo, monospace',fontSize:12,lineHeight:1.25,cursorBlink:true,scrollback:5000});
const fit=new FitAddon.FitAddon();terminal.loadAddon(fit);terminal.open($('terminal'));
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const openable=item=>Boolean(item && item.url);
let layoutSaveTimer=null;
function saveLayout(){clearTimeout(layoutSaveTimer);return new Promise(resolve=>{layoutSaveTimer=setTimeout(()=>resolve(call('appearance',{layout}).catch(()=>{})),150);});}
async function applyLayout(next,persist=true){layout={...layout,...next};document.body.classList.toggle('agent-collapsed',layout.agentCollapsed);$('claude-rail').classList.toggle('on',!layout.agentCollapsed);size();if(persist)await saveLayout();}
function markdown(text){return DOMPurify.sanitize(marked.parse(String(text || ''),{gfm:true}),{FORBID_TAGS:['style','form','input','iframe','object','embed'],FORBID_ATTR:['style','srcset']});}
function notice(text,options={}){$('status').textContent=text;return toast(text,options);}

function toast(text,options={}){const {action,onAction,duration=4000}=options;
 const host=$('toasts');const node=document.createElement('div');node.className='toast';const span=document.createElement('span');span.textContent=text;node.append(span);
 let done=false;const finish=()=>{if(done)return;done=true;node.classList.add('toast-out');setTimeout(()=>node.remove(),200);};
 if(action){const b=document.createElement('button');b.textContent=action;b.onclick=()=>{finish();attempt(onAction);};node.append(b);}
 for(const extra of options.actions || []){const b=document.createElement('button');b.textContent=extra.label;b.onclick=()=>{finish();attempt(extra.run);};node.append(b);}
 const close=document.createElement('button');close.className='toast-close';close.textContent='×';close.setAttribute('aria-label','Dismiss');close.onclick=finish;node.append(close);
 host.append(node);while(host.children.length>4)host.firstElementChild.remove();
 requestAnimationFrame(()=>node.classList.add('toast-in'));setTimeout(finish,duration);return finish;
}

function undoable(text,restore){return notice(text,{action:'Undo',onAction:restore,duration:8000});}

async function attempt(fn){try{return await fn();}catch(e){notice(e.message.replace(/^Error invoking remote method '[^']+': Error: /,''));}}




function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}

function closePopovers(){$('ctx-menu').classList.add('hidden');$('ctx-menu').replaceChildren();}

function showMenu(items,x,y){
 closePopovers();const menu=$('ctx-menu');const host=document.querySelector('dialog[open]') || document.body;if(menu.parentElement!==host)host.append(menu);
 for(const item of items){if(item==='-'){menu.append(document.createElement('hr'));continue;}const b=el('button',item.checked?'checked':'',item.label);b.type='button';if(item.hint)b.append(el('kbd','menu-hint',item.hint));b.onclick=()=>{if(item.keep){showMenu(item.run(),x,y);return;}closePopovers();attempt(()=>item.run());};menu.append(b);}
 menu.classList.remove('hidden');
 const w=menu.offsetWidth,h=menu.offsetHeight,aside=document.querySelector('body>aside').getBoundingClientRect();
 // Inside the sidebar the menu sits above everything; over the centre it would be hidden behind the web pages, so only then are they paused.
 const fits=x<aside.right && aside.width>=w+8;
 if(fits)menu.style.left=Math.max(4,Math.min(x,aside.right-w-4))+'px';else{menu.style.left=Math.max(4,Math.min(x,innerWidth-w-8))+'px';}
 menu.style.top=Math.max(4,Math.min(y,innerHeight-h-8))+'px';
}

function askName(title,value=''){
 return new Promise(resolve=>{
  namePending=resolve;$('name-title').textContent=title;$('name-input').value=value;
  $('name-dialog').showModal();$('name-input').focus();$('name-input').select();
 });
}

function onDialogClosed(dialog,fn){let armed=false;dialog.addEventListener('toggle',e=>{if(e.newState==='open')armed=true;else if(armed){armed=false;fn();}});dialog.addEventListener('close',()=>{if(armed){armed=false;fn();}});}

function applyTheme(value){theme=value;document.body.dataset.theme=value;$('theme-moon').hidden=value!=='light';$('theme-sun').hidden=value==='light';$('theme-toggle').title=value==='light'?'Switch to dark mode':'Switch to light mode';$('theme-toggle').setAttribute('aria-label',value==='light'?'Switch to dark mode':'Switch to light mode');terminal.options.theme=value==='light'?{background:'#fbfcfe',foreground:'#354258',cursor:'#5278c8',selectionBackground:'#e6eefc'}:{background:'#151816',foreground:'#d5ddcc',cursor:'#c4d3ab',selectionBackground:'#424e36'};}

function size(){if(!running || mode!=='terminal' || layout.agentCollapsed)return;fit.fit();call('terminal-size',{cols:terminal.cols,rows:terminal.rows}).catch(()=>{});}

function applyMode(next){mode=next==='terminal'?'terminal':'chat';for(const name of ['chat','terminal'])$('mode-'+name).setAttribute('aria-pressed',mode===name);$('chat-view').classList.toggle('hidden',mode!=='chat');$('agent-empty').classList.toggle('hidden',next!=='terminal' || running);$('terminal').classList.toggle('hidden',next!=='terminal' || !running);updateAgentStatus();size();}

function updateAgentStatus(){const state=mode==='chat'?(chatState.busy?(chatState.pending.length?'Needs your approval':'Working…'):'Chat · Claude Code'):(running?'Terminal · running':'Terminal · ready');$('agent-state').textContent=state;$('rail-state').textContent=chatState.pending.length?'●':chatState.busy || running?'·':'';}



function setLocked(value,method){if(typeof value==='object'){method=value.method;value=value.locked;}document.body.classList.toggle('is-locked',value);$('lock-screen').classList.toggle('hidden',!value);if(value){const passcode=method==='passcode';$('unlock-passcode').classList.toggle('hidden',!passcode);$('lock-screen-copy').textContent=passcode?'Enter your Just Zen passcode to restore this workspace.':'Use Touch ID to restore your workspace.';$('unlock-app').textContent=passcode?'Unlock':'Unlock with Touch ID';(passcode?$('unlock-passcode'):$('unlock-app')).focus();closePopovers();}else $('unlock-passcode').value='';}

function showVersion(state){if(state?.version)$('app-version').textContent='JUST ZEN · '+state.version;}

function setRoot(value){root=value;$('folder-name').textContent=value?value.split('/').pop():'Make yourself at home';$('folder-path').textContent=pretty(value) || 'Connect a vault or project to begin.';$('choose-folder').textContent='Add folder';}

function setClaudeAccess({root:nextRoot,policy=claudePolicy,workspaces=claudeWorkspaces}){claudeRoot=nextRoot || null;claudePolicy=policy;claudeWorkspaces=workspaces || [];$('claude-workspace').replaceChildren(new Option('No folder connected',''));for(const value of claudeWorkspaces)$('claude-workspace').add(new Option(value.split('/').pop(),value));$('claude-workspace').value=claudeRoot || '';$('claude-workspace').title=pretty(claudeRoot) || '';$('claude-policy').value=claudePolicy;$('claude-policy').disabled=!claudeRoot;$('disconnect-claude').disabled=!claudeRoot;$('chat-folder').textContent=claudeRoot?claudeRoot.split('/').pop():'Choose a Claude workspace to begin';$('chat-folder').title=pretty(claudeRoot) || '';const notes={full:'Full access to the selected folder. Shell commands still require explicit review.',notes:'Markdown changes are allowed. Other writes and commands require explicit approval.',readOnly:'Read tools only. File changes and commands are blocked in Chat.'};$('claude-access-note').textContent=claudeRoot?pretty(claudeRoot)+' · '+notes[claudePolicy]:'Claude is disconnected from local files.';document.body.classList.toggle('claude-disconnected',!claudeRoot);}


async function chooseClaude(){const state=await call('choose-claude-folder');if(state){setClaudeAccess(state);notice('Claude can now access '+pretty(state.root));return true;}return false;}






async function start(kind){if(kind!=='login' && !claudeRoot && !await chooseClaude())return;await call('start-terminal',kind);running=true;loginInProgress=kind==='login';await applyLayout({agentCollapsed:false});applyMode('terminal');requestAnimationFrame(size);terminal.focus();if(loginInProgress)notice('Signing in: finish in the browser window that opens, then return to Chat.');}

async function refreshClaudeAuth(){try{const status=await call('claude-auth-status');$('chat-signin').classList.toggle('hidden',status.loggedIn);$('claude-login').classList.toggle('hidden',status.loggedIn);$('claude-logout').classList.toggle('hidden',!status.loggedIn);}catch{}}


const chatNodes=new Map(),permissionNodes=new Map();
function replyLines(text){return String(text || '').split('\n').map(l=>l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/,'').replace(/^\[[ xX]\]\s*/,'').replace(/\*\*/g,'').trim()).filter((l,i,a)=>l && /^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+/.test(String(text).split('\n')[i] || '')).slice(0,50);}

function replyActions(message,state){
 const bar=el('div','reply-actions');const lines=replyLines(message.text);const links=[...new Set((String(message.text || '').match(/https?:\/\/[^\s)<>"']+/g) || []).map(u=>u.replace(/[.,;:]+$/,'')))].slice(0,3);
 const idx=state.messages.indexOf(message);let from=null;for(let i=idx-1;i>=0;i--){const mm=state.messages[i];if(mm.role==='user'){from=mm.from || null;break;}}
 if(lines.length){const b=el('button',null,'Add '+lines.length+' as tasks');b.type='button';b.onclick=()=>attempt(async()=>{const result=await call('add-todos',{texts:lines,from});todos=result.todos;taskTab='todo';renderTodos();if(!document.body.classList.contains('tasks-open'))$('tasks-rail').click();notice(result.added+' task'+(result.added===1?'':'s')+' added.');});bar.append(b);}

 return bar;
}

function draftBlocks(text){const out=[];const re=/```message:([^\n`]+)\n([\s\S]*?)```/g;let m;while((m=re.exec(String(text || ''))))out.push({app:m[1].trim(),text:m[2].trim()});return out;}

function stripCode(text){return String(text || '').replace(/```[\s\S]*?```/g,s=>s.replace(/^```[^\n]*\n?/,'').replace(/```$/,'')).trim();}

function surfaceSignIn(messages){const last=messages?.[messages.length-1];if(last && last.role==='error' && /sign in again/i.test(String(last.text || ''))){$('chat-signin').classList.remove('hidden');$('claude-login').classList.remove('hidden');}}

function renderChat(state){chatState=state;surfaceSignIn(state.messages);const scroller=$('chat-messages');const nearBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<90;if(state.messages.length && scroller.querySelector('.chat-welcome'))scroller.replaceChildren();const ids=new Set(state.messages.map(m=>m.id));for(const [id,node] of chatNodes)if(!ids.has(id)){node.remove();chatNodes.delete(id);}
  for(const message of state.messages){let node=chatNodes.get(message.id);if(!node){node=document.createElement(message.role==='tool'?'details':'div');node.className='chat-message '+message.role;chatNodes.set(message.id,node);scroller.append(node);}const signature=JSON.stringify(message);if(node.dataset.signature===signature)continue;node.dataset.signature=signature;
    if(message.role==='tool'){const open=node.open;node.replaceChildren();const summary=document.createElement('summary');summary.textContent=message.tool+' · '+message.status;const pre=document.createElement('pre');pre.textContent=message.text+(message.output?'\n\n'+message.output:'');node.append(summary,pre);node.open=open;}
    else if(message.role==='assistant'){node.classList.add('markdown-body');node.innerHTML=markdown(message.text || '…');if(!state.busy || message!==state.messages.at(-1))node.append(replyActions(message,state));}
    else{node.textContent=message.text;const chip=fromChip(message.from);if(chip){node.append(document.createTextNode(' '));node.append(chip);}}
  }
  if(!state.messages.length && !scroller.querySelector('.chat-welcome'))scroller.append(chatWelcome.cloneNode(true));
  const live=new Set((state.pending || []).map(p=>p.id));for(const [id,node] of permissionNodes)if(!live.has(id)){node.remove();permissionNodes.delete(id);}
  for(const request of state.pending || []){if(permissionNodes.has(request.id))continue;const card=document.createElement('div');card.className='permission-card';const title=document.createElement('strong');title.textContent=request.title;card.append(title);if(request.description){const p=document.createElement('p');p.textContent=request.description;card.append(p);}const answers={};if(request.tool==='AskUserQuestion'){for(const q of request.input.questions || []){const label=document.createElement('label');label.textContent=q.question;const field=document.createElement('textarea');field.rows=2;field.placeholder=(q.options || []).map(o=>o.label).join(' / ');label.append(field);card.append(label);answers[q.question]=field;}}else{const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Review action';pre.textContent=JSON.stringify(request.input,null,2);detail.append(summary,pre);detail.open=true;card.append(detail);}const actions=document.createElement('div');actions.className='dialog-actions';for(const allow of [false,true]){const b=document.createElement('button');b.className=allow?'primary':'secondary';b.textContent=allow?(request.tool==='AskUserQuestion'?'Send answer':'Allow once'):'Deny';b.onclick=()=>attempt(()=>call('chat-permission',{id:request.id,allow,answers:Object.fromEntries(Object.entries(answers).map(([q,f])=>[q,f.value]))}));actions.append(b);}card.append(actions);permissionNodes.set(request.id,card);$('chat-permissions').append(card);}
  $('chat-send').disabled=state.busy;$('new-chat').disabled=state.busy;updateAgentStatus();if(nearBottom)scroller.scrollTop=scroller.scrollHeight;
}

function showClaudeContext(context){
 claudeContext={text:String(context.text).slice(0,20000),source:context.source || 'your selection',from:context.from || null};
 $('chat-context-title').textContent=(context.whole?'Text from ':'Selected text from ')+claudeContext.source+' · '+claudeContext.text.length.toLocaleString()+' characters';
 $('chat-context-preview').textContent=claudeContext.text.slice(0,400);
 $('chat-context').classList.remove('hidden');
 attempt(async()=>{await applyLayout({agentCollapsed:false});applyMode('chat');});
}

async function sendClaudeContext(instruction){
 if(!claudeContext)return;const {text,source}=claudeContext;
 if(!claudeRoot && !await chooseClaude())return;
 await call('chat-send',instruction+'\n\nThe text below came from '+source+'.\n\n"""\n'+text+'\n"""',{from:claudeContext.from});clearClaudeContext();
}

function clearClaudeContext(){claudeContext=null;$('chat-context').classList.add('hidden');if($('chat-about').value)$('chat-about').value='';}

async function toggleTodo(todo,box){if(!todo.done){const ok=confirm('Mark "'+todo.text+'" as complete?');if(!ok){if(box)box.checked=false;return false;}}todos=await call('toggle-todo',todo.id);renderTodos();return true;}

function todoRow(todo){
 const row=el('label','todo-row');const box=document.createElement('input');box.type='checkbox';box.checked=todo.done;box.onchange=()=>attempt(()=>toggleTodo(todo,box));
 const text=el('span',null,todo.text);const chip=fromChip(todo.from);if(chip)text.append(document.createTextNode(' '),chip);
 const move=el('button','todo-move','⋯');move.type='button';move.title='Move this task to a list';move.setAttribute('aria-label','Move task');
 move.onclick=e=>{e.preventDefault();e.stopPropagation();const r=move.getBoundingClientRect();taskMenu(todo,r.left-150,r.bottom+4);};
 const del=el('button','todo-delete','×');del.type='button';del.title='Delete task';del.setAttribute('aria-label','Delete task');
 del.onclick=e=>{e.preventDefault();e.stopPropagation();attempt(async()=>{const result=await call('delete-todo',todo.id);todos=result.todos;renderTodos();undoable('Deleted task',async()=>{todos=await call('restore-todo',result.snapshot);renderTodos();});});};
 row.append(box,text,move,del);
 row.draggable=true;row.dataset.todo=todo.id;
 row.ondragstart=e=>{taskDrag=todo.id;e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',todo.text);}catch{}row.classList.add('dragging');};
 row.ondragend=()=>{taskDrag=null;row.classList.remove('dragging');for(const h of document.querySelectorAll('.task-list-head'))h.classList.remove('drop');};
 return row;
}

function taskMenu(todo,x,y){
 const others=taskFolders.filter(f=>f.id!==todo.folderId);
 showMenu([
  ...(todo.folderId?[{label:'Take out of '+folderName(todo.folderId),run:()=>moveTask(todo.id,null)}]:[]),
  ...others.map(f=>({label:'Move to '+f.name,run:()=>moveTask(todo.id,f.id)})),
  ...(others.length||todo.folderId?['-']:[]),
  {label:'New list with this task…',run:()=>attempt(async()=>{const id=await newTaskList();if(id)await moveTask(todo.id,id);})}
 ],x,y);
}

async function moveTask(id,folderId){todos=await call('move-task',{id,folderId});renderTodos();}

async function newTaskList(name){
 const clean=name===undefined?await askName('Name this list','Client work'):name;
 if(!clean)return null;
 const result=await call('create-task-folder',{name:clean});
 taskFolders=result.folders;taskTarget=result.id;renderTodos();return result.id;
}

function caretGlyph(){const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('aria-hidden','true');svg.classList.add('caret');const p=document.createElementNS(ns,'path');p.setAttribute('d','M7 5l6 5-6 5');svg.append(p);return svg;}

function listHead(folder,count){
 const id=folder?folder.id:'';const head=el('div','task-list-head');head.dataset.list=id;
 const folded=foldedLists.has(id);
 const toggle=()=>{if(foldedLists.has(id))foldedLists.delete(id);else foldedLists.add(id);rememberFolded();renderTodos();};
 const twist=el('button','task-twist');twist.type='button';twist.setAttribute('aria-expanded',String(!folded));
 twist.title=folded?'Show these tasks':'Hide these tasks';twist.append(caretGlyph());
 twist.onclick=e=>{e.stopPropagation();toggle();};
 const name=el('b',null,folder?folder.name:'Everything else');
 const n=el('small',null,count?String(count):'');
 head.append(twist,name,n);
 head.classList.toggle('folded',folded);
 head.title=(folded?'Show':'Hide')+' the tasks in '+(folder?folder.name:'Everything else');
 head.onclick=e=>{if(e.target.closest('.task-list-add,.task-list-more'))return;toggle();};
 if(folder){
  const add=el('button','task-list-add','＋');add.type='button';add.title='Add a task to '+folder.name;
  add.onclick=()=>{taskTarget=folder.id;renderTodos();$('todo-input').focus();};
  const more=el('button','task-list-more','⋯');more.type='button';more.title=folder.name+' list';
  more.onclick=e=>{const r=more.getBoundingClientRect();showMenu([
   {label:'Add a task here',run:()=>{taskTarget=folder.id;renderTodos();$('todo-input').focus();}},
   {label:'Rename…',run:()=>attempt(async()=>{const next=await askName('Rename this list',folder.name);if(!next)return;taskFolders=await call('rename-task-folder',{id:folder.id,name:next});renderTodos();})},
   '-',
   {label:'Delete the list',hint:'Tasks move to Everything else',run:()=>attempt(async()=>{const result=await call('remove-task-folder',{id:folder.id});taskFolders=result.folders;todos=result.todos;if(taskTarget===folder.id)taskTarget=null;renderTodos();})}
  ],r.left-150,r.bottom+4);};
  head.append(add,more);
  if(taskTarget===folder.id)head.classList.add('target');
 }
 head.ondragover=e=>{if(!taskDrag)return;e.preventDefault();e.dataTransfer.dropEffect='move';head.classList.add('drop');};
 head.ondragleave=()=>head.classList.remove('drop');
 head.ondrop=e=>{e.preventDefault();head.classList.remove('drop');const id=taskDrag;taskDrag=null;if(id)attempt(()=>moveTask(id,folder?folder.id:null));};
 return head;
}

// Where a task came from: a note, or the window itself.
function fromChip(from){
 if(!from || from.kind!=='note')return null;
 const chip=el('button','from-chip','↩ '+String(from.path || '').split('/').pop());
 chip.type='button';chip.title='Open the note this came from';
 chip.onclick=e=>{e.preventDefault();e.stopPropagation();attempt(()=>openFile(from.path));};
 return chip;
}
function renderTodos(){
 
 const done=taskTab==='done';
 $('todo-tab').setAttribute('aria-pressed',!done);$('done-tab').setAttribute('aria-pressed',done);$('todo-form').classList.toggle('hidden',done);
 const host=$('todo-list');host.replaceChildren();
 const list=todos.filter(todo=>todo.done===done);
 $('task-count').textContent=todos.filter(todo=>!todo.done).length || '';
 if(taskTarget && !taskFolders.some(f=>f.id===taskTarget))taskTarget=null;
 $('todo-input').placeholder=taskTarget?'Add to '+folderName(taskTarget)+'…':'Add a task…';
 $('todo-target').textContent=taskTarget?folderName(taskTarget):'';
 $('todo-target').hidden=!taskTarget;
 const groups=[...taskFolders.map(f=>({folder:f,items:list.filter(t=>t.folderId===f.id)})),{folder:null,items:list.filter(t=>!t.folderId || !taskFolders.some(f=>f.id===t.folderId))}];
 let shown=0;
 for(const group of groups){
  const id=group.folder?group.folder.id:'';
  if(!group.folder && !group.items.length && taskFolders.length)continue;
  if(taskFolders.length)host.append(listHead(group.folder,group.items.length));
  if(taskFolders.length && foldedLists.has(id))continue;
  for(const todo of group.items){host.append(todoRow(todo));shown++;}
  if(taskFolders.length && !group.items.length)host.append(el('p','todo-empty todo-empty-list',done?'Nothing finished here yet.':'Nothing in this list.'));
 }
 if(!list.length && !taskFolders.length)host.append(el('p','todo-empty',done?'Completed tasks will appear here.':'Nothing waiting. A clear list is a good list.'));
}

function rememberFolded(){try{localStorage.setItem('zen-folded-lists',JSON.stringify([...foldedLists]));}catch{}}

function folderName(id){return taskFolders.find(f=>f.id===id)?.name || '';}

function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}}

// ---- Beyond this window: the panel, the menu bar, deep links, tab reuse ----

// ---- Startup ----
function hydrate(state){
 homeDir=state.home || homeDir;platform=state.platform || platform;
 document.body.classList.toggle('platform-win',platform==='win32');
 if(state.claudeSupported===false){$('agent-state').textContent='Not available on Windows yet';const card=$('chat-signin');if(card){card.replaceChildren(el('h3',null,'Claude is macOS-only for now'),el('p',null,'Claude runs inside a macOS sandbox, and Just Zen will not run it without one. The panel, ⌥Space, your notes and your tasks all work.'));}}
 showVersion(state);attempt(refreshClaudeAuth);
 setLocked(false);setRoot(state.root);
 setClaudeAccess({root:state.claudeRoot,policy:state.claudePolicy,workspaces:state.claudeWorkspaces});
 todos=state.todos || [];taskFolders=state.taskFolders || [];renderTodos();
 applyTheme(state.theme);renderChat(state.chat);applyMode(state.mode);
 layout={agentCollapsed:state.layout?.agentCollapsed!==false};
 applyLayout({},false);
}
$('claude-rail').onclick=()=>attempt(async()=>{await applyLayout({agentCollapsed:!layout.agentCollapsed});if(!layout.agentCollapsed){applyMode(mode==='terminal'?'terminal':'chat');$('chat-input')?.focus();}});
$('tasks-rail').onclick=()=>{document.body.classList.add('tasks-open');requestAnimationFrame(()=>$('todo-input').focus());};
$('close-tasks').onclick=()=>document.body.classList.remove('tasks-open');
$('sidecar-rail').onclick=()=>attempt(()=>call('flick-toggle',{}));
$('theme-toggle').onclick=()=>attempt(async()=>{const next=theme==='dark'?'light':'dark';await call('appearance',{theme:next});applyTheme(next);});
$('todo-tab').onclick=()=>{taskTab='todo';renderTodos();};
$('done-tab').onclick=()=>{taskTab='done';renderTodos();};
$('todo-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{todos=await call('add-todo',{text:$('todo-input').value,folderId:taskTarget});$('todo-input').value='';taskTab='todo';renderTodos();});};
$('new-list').onclick=()=>attempt(()=>newTaskList());
$('todo-target').onclick=()=>{taskTarget=null;renderTodos();$('todo-input').focus();};
window.hearth.on('todos-changed',list=>{todos=list;taskTab='todo';renderTodos();if(!document.body.classList.contains('tasks-open'))$('tasks-rail').click();});
$('name-cancel').onclick=()=>$('name-dialog').close();
$('chat-form').onsubmit=e=>{e.preventDefault();attempt(async()=>{const prompt=$('chat-input').value;if(!prompt.trim())return;if(!claudeRoot && !await chooseClaude())return;let text=prompt,from=composerFrom;if(claudeContext && !claudeContext.sent && !prompt.includes(claudeContext.text.slice(0,200))){text=prompt+'\n\nThe text below came from '+claudeContext.source+'.\n\n"""\n'+claudeContext.text+'\n"""';from=from || claudeContext.from;claudeContext.sent=true;}await call('chat-send',text,{from});composerFrom=null;$('chat-input').value='';});};
$('chat-input').onkeydown=e=>{if(e.key==='Enter' && !e.shiftKey && !e.isComposing){e.preventDefault();if(!chatState.busy)$('chat-form').requestSubmit();}};
$('new-chat').onclick=()=>attempt(async()=>{if(chatState.messages.length && !confirm('Start a new conversation? The previous session remains in Claude Code\u2019s history.'))return;await call('chat-new');});
$('stop').onclick=()=>attempt(()=>call('chat-stop'));
for(const next of ['chat','terminal'])$('mode-'+next).onclick=()=>attempt(async()=>{applyMode(next);await call('appearance',{mode:next});});
terminal.onData(data=>call('terminal-input',data).catch(e=>notice(e.message)));
window.hearth.on('terminal-data',data=>terminal.write(data));
window.hearth.on('notice',notice);
window.hearth.on('chat-state',renderChat);
window.hearth.on('terminal-exit',code=>{running=false;const wasLogin=loginInProgress;loginInProgress=false;terminal.reset();if(wasLogin){applyMode('chat');notice(code===0?'Signed in to Claude. You can chat now.':'Sign-in did not complete · exit '+code);attempt(refreshClaudeAuth);return;}applyMode(mode);notice('Terminal session ended · exit '+code);});
window.hearth.on('app-locked',setLocked);
window.hearth.on('data-erased',()=>notice('All Just Zen data erased.'));
window.hearth.on('capture-selection',payload=>{const target=payload && typeof payload==='object'?payload.target:'claude';const found=String(window.getSelection?.() || '').trim();if(!found){notice('Select some text first.');return;}if(target==='task')attempt(async()=>{todos=await call('add-todo',{text:found});renderTodos();notice('Added to your tasks.');});else showClaudeContext({text:found,source:'this window'});});
window.hearth.on('claude-context',context=>{if(context && typeof context.text==='string')showClaudeContext(context);});
for(const b of document.querySelectorAll('#chat-context [data-instruction]'))b.onclick=()=>attempt(()=>sendClaudeContext(b.dataset.instruction));
$('chat-context-ask').onclick=()=>{if(!claudeContext)return;const {text,source}=claudeContext;composerFrom=claudeContext.from || null;$('chat-input').value='\n\nThe text below came from '+source+'.\n\n"""\n'+text+'\n"""';$('chat-input').setSelectionRange(0,0);$('chat-input').focus();clearClaudeContext();};
$('chat-context-discard').onclick=clearClaudeContext;
new ResizeObserver(size).observe($('terminal'));
document.addEventListener('keydown',e=>{
 if(!e.metaKey && !e.ctrlKey)return;
});
window.addEventListener('beforeunload',e=>{if(running || chatState.busy){if(!confirm('Close this window? Unsaved edits and running work will be stopped.')){e.preventDefault();e.returnValue=false;}}});
attempt(async()=>{const state=await call('state');applyTheme(state.theme || 'light');showVersion(state);if(state.locked)setLocked(true,state.lockMethod);else hydrate(state);});
