// The group popover: a small floating window listing the apps in one sidebar group.
const $=id=>document.getElementById(id);
function iconNode(icon,cls){if(typeof icon==='string' && icon.startsWith('ms:') && window.MATERIAL_ICONS?.[icon.slice(3)]){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','ms-icon'+(cls?' '+cls:''));svg.innerHTML=window.MATERIAL_ICONS[icon.slice(3)];return svg;}const span=document.createElement('span');span.className=cls || '';span.textContent=icon || '◫';return span;}
let current=null;
window.popover.onShow(data=>{
  current=data;document.body.dataset.theme=data.theme || 'light';
  $('icon').replaceChildren(iconNode(data.folder.icon || '◫'));$('name').textContent=data.folder.name;
  const grid=$('grid');grid.replaceChildren();
  for(const item of data.items){
    const tile=document.createElement('button');tile.className='tile';tile.title=item.name;
    const out=document.createElement('b');out.className='out';out.textContent='×';out.title='Remove from this group';out.onclick=e=>{e.stopPropagation();window.popover.send('popover-remove',{folderId:data.folder.id,key:item.key});};
    let art;if(item.icon){art=document.createElement('img');art.src=item.icon;art.alt='';}else{if(item.emoji){art=document.createElement('span');art.className='emoji';art.append(iconNode(item.emoji));}else{art=document.createElement('span');art.className='fallback';art.textContent=item.name.slice(0,1).toUpperCase();}}
    const label=document.createElement('span');label.textContent=item.name;
    tile.append(out,art,label);
    if(item.badge){const badge=document.createElement('small');badge.className='badge';badge.textContent=item.badge>99?'99+':String(item.badge);tile.append(badge);}
    tile.onclick=()=>window.popover.send('popover-open',item.key);
    grid.append(tile);
  }
  if(!data.items.length){const p=document.createElement('p');p.className='empty';p.textContent='No apps here yet. Edit the group to add some, or drag apps onto it in the sidebar.';grid.append(p);}
  const cols=Math.max(1,Math.min(4,data.items.length || 1));grid.style.gridTemplateColumns='repeat('+cols+',118px)';
  // Measured synchronously: a hidden window gets no animation frames, so a deferred measurement would never arrive.
  const box=$('card').getBoundingClientRect();window.popover.send('popover-size',{width:Math.ceil(box.width)+20,height:Math.ceil(box.height)+20});
});
$('edit').onclick=()=>{if(current)window.popover.send('popover-edit',current.folder.id);};
$('close').onclick=()=>window.popover.send('popover-close');
document.addEventListener('keydown',e=>{if(e.key==='Escape')window.popover.send('popover-close');});
