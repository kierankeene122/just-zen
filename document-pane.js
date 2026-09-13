export function createDocumentPane({call,resize}){
 const $=id=>document.getElementById(id);let current=null,dirty=false,pdf=null,loadingTask=null,page=1,zoom=1,annotations=[],renderTask=null,renderVersion=0,busy=false,deck=null,slideAt=0;const deckEdits=new Map();
 const status=text=>$('document-status').textContent=text;
 const changed=()=>{dirty=true;status('Unsaved edits — original unchanged');};
 const run=async fn=>{if(busy)return;busy=true;try{await fn();}catch(e){status(e.message);}finally{busy=false;}};
 $('documents-close').onclick=()=>window.documents.collapse();
 window.documents.onOpenRequest?.(()=>$('document-open').click());
 $('document-editor').oninput=changed;$('document-text').oninput=changed;
 for(const button of document.querySelectorAll('[data-format]')){button.onmousedown=e=>e.preventDefault();button.onclick=()=>{document.execCommand(button.dataset.format);changed();};}
 $('document-editor').addEventListener('paste',event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));});
 $('document-editor').addEventListener('drop',event=>event.preventDefault());
 async function paint(){
  if(!pdf)return;const version=++renderVersion;
  if(renderTask){renderTask.cancel();try{await renderTask.promise;}catch{}}
  const sheet=await pdf.getPage(page);if(version!==renderVersion)return;
  const viewport=sheet.getViewport({scale:zoom}),canvas=$('pdf-canvas');canvas.width=viewport.width;canvas.height=viewport.height;
  $('pdf-sheet').style.width=viewport.width+'px';$('pdf-sheet').style.height=viewport.height+'px';
  renderTask=sheet.render({canvasContext:canvas.getContext('2d'),viewport});try{await renderTask.promise;}catch(e){if(e.name!=='RenderingCancelledException')throw e;}
  $('pdf-page').textContent=page+' / '+pdf.numPages;$('pdf-prev').disabled=page===1;$('pdf-next').disabled=page===pdf.numPages;
  $('pdf-notes').replaceChildren();for(const a of annotations.filter(a=>a.page===page)){const note=document.createElement('span');note.textContent=a.text;note.style.cssText=`left:${a.x*100}%;top:${a.y*100}%;font-size:${12*zoom}px`; $('pdf-notes').append(note);}
 }
 $('document-open').onclick=()=>run(async()=>{
  if(dirty&&!confirm('Discard unsaved document edits and open another file?'))return;
  const file=await call('document-open');if(!file)return;
  if(loadingTask)await loadingTask.destroy();pdf=null;loadingTask=null;current=file;dirty=false;annotations=[];page=1;zoom=.6;
  $('document-name').textContent=file.name;$('document-tools').hidden=false;
  const isPDF=file.type==='pdf',plain=file.type==='txt',isDeck=file.type==='pptx';deck=null;document.body.classList.remove('presenting');
  $('document-editor').hidden=isPDF||plain||isDeck;$('document-text').hidden=!plain;$('pdf-sheet').hidden=!isPDF;$('pdf-tools').hidden=!isPDF;$('deck').hidden=!isDeck;$('deck-tools').hidden=!isDeck;$('document-save').hidden=isDeck;
  for(const b of document.querySelectorAll('[data-format]'))b.hidden=isPDF||plain||isDeck;
  if(isDeck){deck=JSON.parse(file.content);slideAt=0;deckEdits.clear();$('document-save').hidden=false;$('document-hint').textContent='Click any text to edit it; Save copy writes a new .pptx with your changes. ← → or Space move between slides; Present fills the pane, Esc brings the controls back.';$('document-name').title=$('document-hint').textContent;paintSlide();status('Opened locally');return;}
  if(isPDF){
   $('document-hint').textContent='Click a page to add text. Save copy adds these notes to the PDF; existing page text is preserved. Notes use the standard Latin font.';
   const lib=await import('./node_modules/pdfjs-dist/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('./node_modules/pdfjs-dist/build/pdf.worker.mjs',import.meta.url).href;
   loadingTask=lib.getDocument({data:Uint8Array.from(atob(file.content),c=>c.charCodeAt(0)),isEvalSupported:false});pdf=await loadingTask.promise;await paint();
  }else if(plain){$('document-text').value=file.content;$('document-hint').textContent='Edit text and save a new copy.';}
  else{
   $('document-editor').innerHTML=DOMPurify.sanitize(file.content,{ALLOWED_TAGS:['p','br','b','strong','i','em','u','s','ul','ol','li','h1','h2','h3','h4','h5','h6','table','tbody','tr','td','th','blockquote'],ALLOWED_ATTR:[]});
   $('document-hint').textContent='Formatted-text editing. Complex layouts, images and comments may not be retained in the edited copy.';
  }
  status('Opened locally');
 });
 $('pdf-sheet').onclick=event=>run(async()=>{
  const text=$('pdf-note-text').value.trim();if(!text){status('Type a note above, then click where it should appear.');$('pdf-note-text').focus();return;}
  const rect=$('pdf-sheet').getBoundingClientRect();annotations.push({page,x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height,text:text.slice(0,1000)});changed();await paint();
 });
// ---- slides
 const EMU=9525;// EMU per CSS pixel at 96 dpi
 function paintSlide(){if(!deck)return;const slide=deck.slides[slideAt];const W=deck.width/EMU,H=deck.height/EMU;const stage=$('deck-stage'),host=$('deck-slide');host.replaceChildren();host.style.width=W+'px';host.style.height=H+'px';host.style.background=slide?.background || '#fff';
  for(const s of slide?.shapes || []){const el=document.createElement('div');el.className='slide-shape';el.style.left=(s.x/EMU)+'px';el.style.top=(s.y/EMU)+'px';el.style.width=Math.max(1,s.w/EMU)+'px';el.style.height=Math.max(1,s.h/EMU)+'px';if(s.rot)el.style.transform='rotate('+s.rot+'deg)';if(s.geom==='ellipse')el.style.borderRadius='50%';else if(s.geom==='roundRect')el.style.borderRadius=Math.min(s.w,s.h)/EMU*0.1+'px';
   if(s.kind==='image'){const img=document.createElement('img');img.src=s.src;img.alt='';el.append(img);host.append(el);continue;}
   if(s.fill && s.fill!=='transparent')el.style.background=s.fill;if(s.lineColour)el.style.border='1px solid '+s.lineColour;
   el.classList.add('anchor-'+(s.anchor || 't'));el.style.padding=[s.inset.t,s.inset.r,s.inset.b,s.inset.l].map(v=>(v/EMU)+'px').join(' ');if(s.wrap===false)el.style.whiteSpace='nowrap';
   const editKey=s.ref?s.ref.slide+'#'+s.ref.index:null;const edit=editKey?deckEdits.get(editKey):null;const paragraphs=edit?edit.paragraphs.map((t,i)=>{const base=s.paragraphs[i] || s.paragraphs[s.paragraphs.length-1] || {runs:[],align:'l',lvl:0};return {...base,runs:[{...(base.runs[0] || {}),text:t}]};}):(s.paragraphs || []);
   if(editKey && !document.body.classList.contains('presenting')){el.contentEditable='true';el.spellcheck=false;el.dataset.edit=editKey;el.addEventListener('input',()=>{const lines=[...el.querySelectorAll('p')].map(p=>p.innerText.replace(/\n$/,''));deckEdits.set(editKey,{slide:s.ref.slide,index:s.ref.index,paragraphs:lines.length?lines:[el.innerText]});changed();});el.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape')el.blur();});el.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));});el.addEventListener('click',e=>e.stopPropagation());}
   for(const p of paragraphs){const para=document.createElement('p');para.style.textAlign={l:'left',ctr:'center',r:'right',just:'justify'}[p.align] || 'left';if(p.bullet)para.classList.add('bullet');if(p.lvl)para.style.marginLeft=(p.lvl*1.4)+'em';const base=(p.runs.find(r=>r.size)?.size || p.size || s.defaultSize || 18);para.style.fontSize=(base*96/72)+'px';
    if(!p.runs.length)para.append(document.createElement('br'));
    for(const r of p.runs){const span=document.createElement('span');span.textContent=r.text;if(r.size)span.style.fontSize=(r.size*96/72)+'px';if(r.bold)span.style.fontWeight='700';if(r.italic)span.style.fontStyle='italic';const deco=[r.underline?'underline':'',r.strike?'line-through':''].filter(Boolean).join(' ');if(deco)span.style.textDecoration=deco;if(r.color)span.style.color=r.color;if(r.font)span.style.fontFamily='"'+r.font.replace(/"/g,'')+'",-apple-system,sans-serif';para.append(span);}
    el.append(para);}
   host.append(el);}
  fitSlide();$('deck-page').textContent=(slideAt+1)+' / '+deck.slides.length;$('deck-prev').disabled=slideAt===0;$('deck-next').disabled=slideAt>=deck.slides.length-1;
  const notes=slide?.notes || '';$('deck-notes').hidden=!notes || document.body.classList.contains('presenting');$('deck-notes').textContent=notes;}
 function fitSlide(){if(!deck)return;const stage=$('deck-stage'),host=$('deck-slide');const W=deck.width/EMU,H=deck.height/EMU;const pad=document.body.classList.contains('presenting')?0:24;const k=Math.min((stage.clientWidth-pad)/W,(stage.clientHeight-pad)/H);host.style.transform='scale('+k+')';host.style.left=((stage.clientWidth-W*k)/2)+'px';host.style.top=((stage.clientHeight-H*k)/2)+'px';}
 const stepSlide=d=>{if(!deck)return;const next=Math.max(0,Math.min(deck.slides.length-1,slideAt+d));if(next!==slideAt){slideAt=next;paintSlide();}};
 $('deck-prev').onclick=()=>stepSlide(-1);$('deck-next').onclick=()=>stepSlide(1);
 $('deck-present').onclick=()=>{document.body.classList.toggle('presenting');paintSlide();$('deck-stage').focus();};
 $('deck-stage').tabIndex=0;$('deck-stage').onclick=e=>{if(!deck)return;stepSlide(e.clientX<$('deck-stage').clientWidth*.25?-1:1);};
 document.addEventListener('keydown',e=>{if(!deck || $('deck').hidden)return;if(e.target && /INPUT|TEXTAREA/.test(e.target.tagName) || e.target?.isContentEditable)return;if(e.key==='ArrowRight' || e.key===' ' || e.key==='PageDown' || e.key==='Enter'){e.preventDefault();stepSlide(1);}else if(e.key==='ArrowLeft' || e.key==='PageUp' || e.key==='Backspace'){e.preventDefault();stepSlide(-1);}else if(e.key==='Home'){slideAt=0;paintSlide();}else if(e.key==='End'){slideAt=deck.slides.length-1;paintSlide();}else if(e.key==='Escape' && document.body.classList.contains('presenting')){document.body.classList.remove('presenting');paintSlide();}});
 new ResizeObserver(()=>fitSlide()).observe($('deck-stage'));
 $('pdf-prev').onclick=()=>run(async()=>{if(page>1){page--;await paint();}});$('pdf-next').onclick=()=>run(async()=>{if(page<pdf.numPages){page++;await paint();}});
 $('pdf-minus').onclick=()=>run(async()=>{zoom=Math.max(.25,zoom-.15);await paint();});$('pdf-plus').onclick=()=>run(async()=>{zoom=Math.min(3,zoom+.15);await paint();});
 $('pdf-undo').onclick=()=>run(async()=>{if(annotations.length){annotations.pop();changed();await paint();}});
 $('document-close').onclick=()=>run(async()=>{if(dirty&&!confirm('Close this document and discard unsaved edits?'))return;deck=null;$('deck').hidden=true;$('deck-tools').hidden=true;document.body.classList.remove('presenting');if(loadingTask)await loadingTask.destroy();await call('document-close');loadingTask=null;pdf=null;current=null;dirty=false;annotations=[];renderTask=null;$('document-editor').innerHTML='';$('document-text').value='';$('pdf-notes').replaceChildren();$('pdf-canvas').width=0;for(const id of ['document-tools','pdf-tools','document-editor','document-text','pdf-sheet'])$(id).hidden=true;$('document-name').textContent='Local files stay on this Mac.';$('document-hint').textContent='Open a PDF, DOCX, TXT or RTF to work alongside your apps.';status('Document closed');});
 $('document-save').onclick=()=>run(async()=>{if(!current)return;const saved=await call('document-save',{content:current.type==='txt'?$('document-text').value:$('document-editor').innerHTML,annotations,edits:[...deckEdits.values()]});if(saved){dirty=false;status('Saved '+saved);}});
 // ⌘⇧A: send the selection to Claude; for a PDF with nothing selected, send the current page's text.
 const slideText=s=>(s.shapes || []).filter(sh=>sh.kind==='shape').map(sh=>(sh.paragraphs || []).map(p=>p.runs.map(r=>r.text).join('')).join('\n')).filter(Boolean).join('\n');
 async function selectedText(){
  const chosen=String(window.getSelection?.() || '').trim();if(chosen)return chosen;
  if(deck)return slideText(deck.slides[slideAt] || {}).trim();
  if(pdf){const sheet=await pdf.getPage(page),content=await sheet.getTextContent();return content.items.map(item=>item.str).join(' ').replace(/\s+/g,' ').trim();}
  if(!$('document-text').hidden)return $('document-text').value.trim();
  if(!$('document-editor').hidden)return $('document-editor').innerText.trim();
  return '';
 }
 async function wholeText(){if(deck)return deck.slides.map((s,i)=>'## Slide '+(i+1)+'\n'+slideText(s)+(s.notes?'\nNotes: '+s.notes:'')).join('\n\n').slice(0,60000);if(pdf){const parts=[];for(let n=1;n<=Math.min(pdf.numPages,40);n++){const sheet=await pdf.getPage(n),content=await sheet.getTextContent();parts.push(content.items.map(item=>item.str).join(' '));}return parts.join('\n\n').replace(/[ \t]+/g,' ').trim();}if(!$('document-text').hidden)return $('document-text').value.trim();if(!$('document-editor').hidden)return $('document-editor').innerText.trim();return '';}
 window.documents.onCaptureSelection?.(target=>run(async()=>{const text=target==='claude-all'?await wholeText():await selectedText();if(target==='claude-all')target='claude';if(!text){status('Select some text first, or open a document.');return;}window.documents.sendSelection(target,text);status(target==='task'?'Added to your tasks.':'Sent to Claude: choose what to do with it in the Claude pane.');}));
 window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='Unsaved document edits';}});
}
