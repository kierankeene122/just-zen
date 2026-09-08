const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const {PDFDocument}=require('pdf-lib'),{createDocuments}=require('./documents.cjs');
test('local document copies support TXT, DOCX, RTF and annotated PDF without changing originals',{skip:process.platform!=='darwin'},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zen-doc-test-'));try{
  for(const type of ['txt','docx','rtf','pdf']){
   const original=path.join(dir,'source.'+type),dest=path.join(dir,'copy.'+type);
   if(type==='pdf'){const pdf=await PDFDocument.create();pdf.addPage();await fs.writeFile(original,await pdf.save());}
   else if(type==='txt')await fs.writeFile(original,'Original text');
   else{await fs.writeFile(path.join(dir,'source.txt'),'Original text');await exec('/usr/bin/textutil',['-convert',type,'-output',original,path.join(dir,'source.txt')]);}
   const before=await fs.readFile(original);
   const docs=createDocuments({showOpenDialog:async()=>({filePaths:[original]}),showSaveDialog:async()=>({filePath:dest})},()=>null);
   const opened=await docs.open();assert.equal(opened.type,type);assert.ok(opened.content);
   await docs.save({content:type==='txt'?'Edited text':'<p><b>Edited text</b></p>',annotations:[{page:1,x:.1,y:.1,text:'Review note'}]});
   assert.deepEqual(await fs.readFile(original),before);docs.close();await assert.rejects(()=>docs.save({content:'No access'}),/Open a document first/);
   if(type==='pdf')assert.equal((await PDFDocument.load(await fs.readFile(dest))).getPageCount(),1);
   else if(type==='txt')assert.equal(await fs.readFile(dest,'utf8'),'Edited text');
   else assert.match((await exec('/usr/bin/textutil',['-convert','txt','-stdout',dest])).stdout,/Edited text/);
  }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
