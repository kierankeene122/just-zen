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

let openFolder='';
function spotFor(pin){
 const spot=document.createElement('button');spot.className='spot';spot.dataset.pin=pin.id;spot.title=pin.label+(pin.detail?' · '+pin.detail:'');
 if(pin.icon){const img=document.createElement('img');img.src=pin.icon;img.alt='';spot.append(img);}
 else{const glyph=document.createElement('span');glyph.className='glyph';glyph.textContent=pin.glyph || '◆';spot.append(glyph);}
 spot.onclick=()=>window.pill.open(pin.id);
 spot.oncontextmenu=e=>{e.preventDefault();window.pill.menu(pin.id);};
 spot.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';spot.classList.add('over');});
 spot.addEventListener('dragleave',()=>spot.classList.remove('over'));
 spot.addEventListener('drop',e=>{
  e.preventDefault();spot.classList.remove('over');
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
 wrap.append(spot);
 const label=document.createElement('div');label.className='folder-name';label.textContent=name.slice(0,7);wrap.append(label);
 return wrap;
}
function render(){
 const host=$('spots');host.replaceChildren();
 if(!pins.length){const empty=document.createElement('div');empty.id='empty';empty.textContent='＋ to add';host.append(empty);return;}
 const groups=new Map();
 for(const pin of pins){const key=pin.folder || '';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(pin);}
 for(const [name,items] of groups){
  if(!name){for(const pin of items)host.append(spotFor(pin));continue;}
  host.append(folderFor(name,items));
  if(openFolder===name){
   const kids=document.createElement('div');kids.className='kids';
   for(const pin of items)kids.append(spotFor(pin));
   host.append(kids);
  }
 }
}
$('add').onclick=()=>window.pill.add();
$('flick').onclick=()=>window.pill.flick();
$('home').onclick=()=>window.pill.home();
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>e.preventDefault());
window.pill.ready();
