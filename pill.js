// The edge pill: the handful of places you flick between, always within reach.
// Clicking one goes there; dropping a file on one opens that file there.
const $=id=>document.getElementById(id);
let pins=[];

window.pill.onTheme(theme=>{document.body.dataset.theme=theme;});
window.pill.onPins(list=>{pins=Array.isArray(list)?list:[];render();});
window.pill.onBadges(map=>{
 for(const spot of document.querySelectorAll('.spot[data-pin]')){
  const count=map && map[spot.dataset.pin];
  let badge=spot.querySelector('small');
  if(count){if(!badge){badge=document.createElement('small');spot.append(badge);}badge.textContent=count>99?'99+':String(count);}
  else if(badge)badge.remove();
 }
});

let openFolder='',dragging=null,draggingFolder=null,groupPair=null;
// The panel is a sequence of blocks: a single icon, or a whole group. Either can be dragged into a new place.
function blocks(){
 const out=[];const byName=new Map();
 for(const pin of pins){
  const name=pin.folder || '';
  if(!name){out.push({kind:'pin',id:pin.id,items:[pin]});continue;}
  const found=byName.get(name);
  if(found){found.items.push(pin);continue;}
  const block={kind:'folder',name,items:[pin]};byName.set(name,block);out.push(block);
 }
 return out;
}
function blockKey(block){return block.kind==='folder'?'folder:'+block.name:'pin:'+block.id;}
function moveBlock(sourceKey,targetKey,after){
 if(sourceKey===targetKey)return;
 const list=blocks();
 const from=list.findIndex(b=>blockKey(b)===sourceKey);
 if(from<0)return;
 const [moved]=list.splice(from,1);
 const at=list.findIndex(b=>blockKey(b)===targetKey);
 if(at<0)return;
 list.splice(at+(after?1:0),0,moved);
 window.pill.order(list.flatMap(b=>b.items.map(p=>p.id)));
}
// The panel's order is the user's: dropping between two icons moves one there, and the main process keeps it.
function reorder(movedId,targetId,after){
 const ids=pins.map(p=>p.id).filter(id=>id!==movedId);
 const at=ids.indexOf(targetId);
 if(at<0)return;
 ids.splice(at+(after?1:0),0,movedId);
 const moved=pins.find(p=>p.id===movedId),target=pins.find(p=>p.id===targetId);
 if(moved && target && moved.folder!==target.folder)window.pill.group(movedId,target.folder || '');
 window.pill.order(ids);
}
function spotFor(pin){
 const spot=document.createElement('button');spot.className='spot';spot.dataset.pin=pin.id;spot.title=pin.label+(pin.detail?' · '+pin.detail:'');
 if(pin.icon){const img=document.createElement('img');img.src=pin.icon;img.alt='';spot.append(img);}
 else{const glyph=document.createElement('span');glyph.className='glyph';glyph.textContent=pin.glyph || '◆';spot.append(glyph);}
 spot.onclick=()=>window.pill.open(pin.id);
 spot.oncontextmenu=e=>{e.preventDefault();window.pill.menu(pin.id);};
 spot.draggable=true;
 spot.addEventListener('dragstart',e=>{dragging=pin.id;e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',pin.label);}catch{}spot.classList.add('lifting');});
 spot.addEventListener('dragend',()=>{dragging=null;draggingFolder=null;spot.classList.remove('lifting');for(const s of document.querySelectorAll('.spot'))s.classList.remove('over','above','below');});
 // Dropping on the top or bottom of an icon moves yours there; dropping on its middle makes a group of the two.
 const zoneFor=e=>{const r=spot.getBoundingClientRect();const y=e.clientY-r.top;return y<r.height*0.33?'before':y>r.height*0.67?'after':'group';};
 spot.addEventListener('dragover',e=>{
  e.preventDefault();e.dataTransfer.dropEffect=(dragging || draggingFolder)?'move':'copy';
  const zone=draggingFolder?(zoneFor(e)==='before'?'before':'after'):(dragging && dragging!==pin.id?zoneFor(e):'group');
  spot.classList.toggle('over',zone==='group');
  spot.classList.toggle('above',zone==='before');
  spot.classList.toggle('below',zone==='after');
 });
 spot.addEventListener('dragleave',()=>spot.classList.remove('over','above','below'));
 spot.addEventListener('drop',e=>{
  e.preventDefault();
  const zone=draggingFolder?(zoneFor(e)==='before'?'before':'after'):(dragging && dragging!==pin.id?zoneFor(e):'group');
  spot.classList.remove('over','above','below');
  if(draggingFolder){const name=draggingFolder;draggingFolder=null;moveBlock('folder:'+name,'pin:'+pin.id,zone==='after');return;}
  if(dragging && dragging!==pin.id){
   const moved=dragging;dragging=null;
   if(zone==='group'){askGroupFor([moved,pin.id],pin.folder);return;}
   reorder(moved,pin.id,zone==='after');
   return;
  }
  const files=[...(e.dataTransfer?.files || [])].map(file=>window.pill.pathFor(file)).filter(Boolean);
  if(files.length)window.pill.drop(pin.id,files);
 });
 return spot;
}
// Groups fold away behind one icon made of the first four things inside them.
function folderFor(name,items){
 const wrap=document.createElement('div');wrap.className='folder';
 const spot=document.createElement('button');spot.className='spot';spot.title=name+' · '+items.length+' thing'+(items.length===1?'':'s');
 const stack=document.createElement('span');stack.className='stack';
 for(const item of items.slice(0,4)){
  if(item.icon){const img=document.createElement('img');img.src=item.icon;img.alt='';stack.append(img);}
  else{const i=document.createElement('i');stack.append(i);}
 }
 while(stack.children.length<4)stack.append(document.createElement('i'));
 spot.append(stack);
 spot.onclick=()=>{openFolder=openFolder===name?'':name;render();};
 spot.oncontextmenu=e=>{e.preventDefault();if(items[0])window.pill.menu(items[0].id);};
 // A group can be picked up whole and put somewhere else on the panel.
 spot.draggable=true;
 spot.addEventListener('dragstart',e=>{draggingFolder=name;dragging=null;e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',name);}catch{}spot.classList.add('lifting');});
 spot.addEventListener('dragend',()=>{draggingFolder=null;spot.classList.remove('lifting');for(const s of document.querySelectorAll('.spot'))s.classList.remove('over','above','below');});
 // Dropping an icon on a group puts it in that group; dropping another group reorders them; a file opens with the first thing inside.
 const folderZone=e=>{const r=spot.getBoundingClientRect();return (e.clientY-r.top)<r.height/2?'before':'after';};
 spot.addEventListener('dragover',e=>{
  e.preventDefault();e.dataTransfer.dropEffect=(dragging || draggingFolder)?'move':'copy';
  if(draggingFolder && draggingFolder!==name){const zone=folderZone(e);spot.classList.toggle('above',zone==='before');spot.classList.toggle('below',zone==='after');spot.classList.remove('over');return;}
  spot.classList.add('over');
 });
 spot.addEventListener('dragleave',()=>spot.classList.remove('over','above','below'));
 spot.addEventListener('drop',e=>{
  e.preventDefault();
  const zone=draggingFolder && draggingFolder!==name?folderZone(e):null;
  spot.classList.remove('over','above','below');
  if(draggingFolder){const moved=draggingFolder;draggingFolder=null;if(moved!==name)moveBlock('folder:'+moved,'folder:'+name,zone==='after');return;}
  if(dragging){const moved=dragging;dragging=null;window.pill.group(moved,name);openFolder=name;return;}
  const files=[...(e.dataTransfer?.files || [])].map(file=>window.pill.pathFor(file)).filter(Boolean);
  if(files.length && items[0])window.pill.drop(items[0].id,files);
 });
 wrap.append(spot);
 const label=document.createElement('div');label.className='folder-name';label.textContent=name.slice(0,7);wrap.append(label);
 return wrap;
}
function render(){
 const host=$('spots');host.replaceChildren();
 document.body.classList.toggle('empty',!pins.length);
 if(!pins.length){const empty=document.createElement('div');empty.id='empty';empty.textContent='Add the apps you flick between';empty.title='Right-click the panel for more';host.append(empty);return;}
 const groups=new Map();
 for(const pin of pins){const key=pin.folder || '';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(pin);}
 for(const [name,items] of groups){
  if(!name){for(const pin of items)host.append(spotFor(pin));continue;}
  host.append(folderFor(name,items));
  if(openFolder===name){
   const kids=document.createElement('div');kids.className='kids';
   kids.addEventListener('dragover',e=>{if(!dragging)return;e.preventDefault();e.dataTransfer.dropEffect='move';kids.classList.add('over');});
   kids.addEventListener('dragleave',()=>kids.classList.remove('over'));
   kids.addEventListener('drop',e=>{e.preventDefault();kids.classList.remove('over');if(!dragging)return;const moved=dragging;dragging=null;window.pill.group(moved,name);});
   for(const pin of items)kids.append(spotFor(pin));
   host.append(kids);
  }
 }
}
// Naming a group happens here, in the panel, because there is nowhere else to ask.
let groupFor=null;
function askGroupFor(ids,suggestion=''){groupPair=Array.isArray(ids)?ids:[ids];groupFor=null;$('group-ask').hidden=false;$('group-name').value=suggestion || '';$('group-name').focus();$('group-name').select();}
window.pill.onAskGroup(id=>{groupPair=null;groupFor=id;$('group-ask').hidden=false;$('group-name').value='';$('group-name').focus();});
$('group-ask').onsubmit=e=>{
 e.preventDefault();const name=$('group-name').value.trim();$('group-ask').hidden=true;
 if(name){for(const id of (groupPair || (groupFor?[groupFor]:[])))window.pill.group(id,name);}
 groupFor=null;groupPair=null;
};
$('group-name').onkeydown=e=>{if(e.key==='Escape'){$('group-ask').hidden=true;groupFor=null;groupPair=null;}};
$('group-name').onblur=()=>{setTimeout(()=>{if(!$('group-ask').hidden && document.activeElement!==$('group-name')){$('group-ask').hidden=true;groupFor=null;}},150);};
$('add').onclick=()=>window.pill.add();
$('flick').onclick=()=>window.pill.flick();
document.addEventListener('contextmenu',e=>{if(e.target.closest('.spot'))return;e.preventDefault();window.pill.menu('');});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>e.preventDefault());
window.pill.ready();
