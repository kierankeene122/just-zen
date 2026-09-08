const fs=require('node:fs/promises'),path=require('node:path');
const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
const {PDFDocument,StandardFonts,rgb}=require('pdf-lib');
const {sanitizeFormattedHtml}=require('./document-sanitize.cjs');
(async()=>{const job=process.argv[2];const {type,input,action}=JSON.parse(await fs.readFile(path.join(job,'request.json'),'utf8'));const data=await fs.readFile(path.join(job,'input'));let output;
if(action==='open'){output=(await execFile('/usr/bin/textutil',['-convert','html','-stdout',path.join(job,'source.'+type)],{maxBuffer:20*1024*1024,timeout:15000})).stdout;}else{
  if(type==='pdf'){
   const doc=await PDFDocument.load(data),font=await doc.embedFont(StandardFonts.Helvetica);
   if(!Array.isArray(input.annotations) || input.annotations.length>1000)throw Error('Invalid annotations');
   for(const a of input.annotations){
    if(!Number.isInteger(a.page)||a.page<1||a.page>doc.getPageCount()||!Number.isFinite(a.x)||!Number.isFinite(a.y)||a.x<0||a.x>1||a.y<0||a.y>1||typeof a.text!=='string'||a.text.length>1000)throw Error('Invalid annotation');
    const page=doc.getPage(a.page-1),{width,height}=page.getSize();
    page.drawText(a.text,{x:a.x*width,y:height-a.y*height-12,size:12,font,color:rgb(.1,.25,.4),maxWidth:Math.max(20,width*(1-a.x)-10)});
   }
   output=await doc.save();
  }else{
   if(typeof input.content!=='string'||input.content.length>20*1024*1024)throw Error('Document too large');
   if(type==='txt')output=input.content;
   else{
    const temp=job;
    try{
     const source=path.join(temp,'edit.html'),destination=path.join(temp,'edit.'+type);
     // Only bare formatted-text tags are exported; no attributes, remote resources or active HTML.
     const html=sanitizeFormattedHtml(input.content);
     await fs.writeFile(source,'<!doctype html><meta charset="utf-8">'+html);
     output=(await execFile('/usr/bin/textutil',['-convert',type,'-stdout',source],{timeout:15000,encoding:'buffer',maxBuffer:50*1024*1024})).stdout;
    }finally{}
   }
  }
}
await fs.writeFile(path.join(job,'output'),output);})().catch(e=>{console.error(e.message);process.exit(1);});
