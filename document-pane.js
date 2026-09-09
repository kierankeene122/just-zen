export function createDocumentPane({call,resize}){
 const $=id=>document.getElementById(id);let current=null,dirty=false,pdf=null,loadingTask=null,page=1,zoom=1,annotations=[],renderTask=null,renderVersion=0,busy=false;
 const status=text=>$('document-status').textContent=text;
 const changed=()=>{dirty=true;status('Unsaved edits — original unchanged');};
 const run=async fn=>{if(busy)return;busy=true;try{await fn();}catch(e){status(e.message);}finally{busy=false;}};
 $('documents-close').onclick=()=>window.documents.collapse();
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
  const isPDF=file.type==='pdf',plain=file.type==='txt';
  $('document-editor').hidden=isPDF||plain;$('document-text').hidden=!plain;$('pdf-sheet').hidden=!isPDF;$('pdf-tools').hidden=!isPDF;
  for(const b of document.querySelectorAll('[data-format]'))b.hidden=isPDF||plain;
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
 $('pdf-prev').onclick=()=>run(async()=>{if(page>1){page--;await paint();}});$('pdf-next').onclick=()=>run(async()=>{if(page<pdf.numPages){page++;await paint();}});
 $('pdf-minus').onclick=()=>run(async()=>{zoom=Math.max(.25,zoom-.15);await paint();});$('pdf-plus').onclick=()=>run(async()=>{zoom=Math.min(3,zoom+.15);await paint();});
 $('pdf-undo').onclick=()=>run(async()=>{if(annotations.length){annotations.pop();changed();await paint();}});
 $('document-close').onclick=()=>run(async()=>{if(dirty&&!confirm('Close this document and discard unsaved edits?'))return;if(loadingTask)await loadingTask.destroy();await call('document-close');loadingTask=null;pdf=null;current=null;dirty=false;annotations=[];renderTask=null;$('document-editor').innerHTML='';$('document-text').value='';$('pdf-notes').replaceChildren();$('pdf-canvas').width=0;for(const id of ['document-tools','pdf-tools','document-editor','document-text','pdf-sheet'])$(id).hidden=true;$('document-name').textContent='Local files stay on this Mac.';$('document-hint').textContent='Open a PDF, DOCX, TXT or RTF to work alongside your apps.';status('Document closed');});
 $('document-save').onclick=()=>run(async()=>{if(!current)return;const saved=await call('document-save',{content:current.type==='txt'?$('document-text').value:$('document-editor').innerHTML,annotations});if(saved){dirty=false;status('Saved '+saved);}});
 // ⌘⇧A: send the selection to Claude; for a PDF with nothing selected, send the current page's text.
 async function selectedText(){
  const chosen=String(window.getSelection?.() || '').trim();if(chosen)return chosen;
  if(pdf){const sheet=await pdf.getPage(page),content=await sheet.getTextContent();return content.items.map(item=>item.str).join(' ').replace(/\s+/g,' ').trim();}
  if(!$('document-text').hidden)return $('document-text').value.trim();
  if(!$('document-editor').hidden)return $('document-editor').innerText.trim();
  return '';
 }
 window.documents.onCaptureSelection?.(target=>run(async()=>{const text=await selectedText();if(!text){status('Select some text first, or open a document.');return;}window.documents.sendSelection(target,text);status(target==='task'?'Added to your tasks.':'Sent to Claude: choose what to do with it in the Claude pane.');}));
 window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='Unsaved document edits';}});
}
