// The flick bar: one field over everything the machine can reach. Results arrive in waves —
// the instant ones (apps, panes, workspaces) first, then documents and Safari tabs as they come back.
const $=id=>document.getElementById(id);
let results=[],index=0,token=0,mode='open';

window.flick.onTheme(theme=>{document.body.dataset.theme=theme;});
window.flick.onShow(next=>{
 mode=next==='pin'?'pin':'open';
 $('q').value='';results=[];index=0;note('');
 $('q').placeholder=mode==='pin'?'Add to the panel: an app, a website, a document…':'Apps, documents, tabs, workspaces…';
 $('hint').textContent=mode==='pin'?'↵ add to panel':'↵ open · ⌘↵ add to panel';
 render();search('');$('q').focus();
});

function note(text){const n=$('note');n.textContent=text||'';n.classList.toggle('on',Boolean(text));}

function render(){
 const list=$('list');list.replaceChildren();
 if(!results.length){const empty=document.createElement('div');empty.id='empty';empty.textContent=$('q').value.trim()?'Nothing matches that yet.':(mode==='pin'?'Pick a web app, or type any address to add your own.':'Type to find an app, a document, a tab or a workspace.');list.append(empty);return;}
 let group='';
 results.forEach((item,i)=>{
  if(item.group!==group){group=item.group;const head=document.createElement('div');head.className='group';head.textContent=group;list.append(head);}
  const row=document.createElement('div');row.className='row';row.setAttribute('role','option');row.setAttribute('aria-selected',String(i===index));
  if(item.icon){const img=document.createElement('img');img.src=item.icon;img.alt='';row.append(img);}
  else{const glyph=document.createElement('span');glyph.className='glyph';glyph.textContent=item.glyph||'◆';row.append(glyph);}
  const b=document.createElement('b');b.textContent=item.label;row.append(b);
  const small=document.createElement('small');small.textContent=item.detail||'';row.append(small);
  const em=document.createElement('em');em.textContent=item.hint||'';row.append(em);
  row.onmousemove=()=>{if(index!==i){index=i;paint();}};
  row.onclick=()=>run(i);
  list.append(row);
 });
 paint();
}
function paint(){
 const rows=[...document.querySelectorAll('.row')];
 rows.forEach((row,i)=>row.setAttribute('aria-selected',String(i===index)));
 rows[index]?.scrollIntoView({block:'nearest'});
}
const GROUP_ORDER=['Pinned','Your web apps','Apps','Web apps','Open tabs','Workspaces','Documents'];
function order(list){
 const seen=new Set();
 const unique=list.filter(item=>{const key=(item.label||'')+'|'+(item.group||'');if(seen.has(key))return false;seen.add(key);return true;});
 return unique.sort((a,b)=>{
  const ga=GROUP_ORDER.indexOf(a.group),gb=GROUP_ORDER.indexOf(b.group);
  return (ga<0?99:ga)-(gb<0?99:gb);
 });
}
async function search(query){
 const mine=++token;
 const first=await window.flick.search({query,stage:'fast',mode});
 if(mine!==token)return;
 results=order(first);index=0;render();
 const rest=await window.flick.search({query,stage:'slow',mode});
 if(mine!==token)return;
 const seen=new Set(results.map(r=>r.id));
 results=order([...results,...rest.filter(r=>!seen.has(r.id))]);
 if(index>=results.length)index=Math.max(0,results.length-1);
 render();
}
async function run(i,pinning=mode==='pin'){
 const item=results[i];if(!item)return;
 try{const outcome=await window.flick.open(item,pinning);if(outcome && outcome.message)note(outcome.message);}
 catch(error){note(String(error && error.message || error));}
}
$('q').oninput=()=>{note('');search($('q').value);};
$('q').onkeydown=e=>{
 if(e.key==='ArrowDown'){e.preventDefault();index=Math.min(results.length-1,index+1);paint();}
 else if(e.key==='ArrowUp'){e.preventDefault();index=Math.max(0,index-1);paint();}
 else if(e.key==='Enter'){e.preventDefault();run(index,mode==='pin' || e.metaKey || e.ctrlKey);}
 else if(e.key==='Escape'){e.preventDefault();window.flick.close();}
};
window.addEventListener('keydown',e=>{if(e.key==='Escape')window.flick.close();});
search('');
