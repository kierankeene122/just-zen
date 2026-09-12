const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
const {runDocumentJob}=require('./document-helper.cjs');
function createDocuments(dialog,getWindow){
 let current=null;
 return {
 close(){current=null;return true;},
 async open(){
  const choice=await dialog.showOpenDialog(getWindow(),{title:'Open local document',properties:['openFile'],filters:[{name:'Documents',extensions:['pdf','docx','txt','rtf']}]});
  if(choice.canceled || !choice.filePaths?.[0])return null;
  const file=choice.filePaths[0],type=path.extname(file).slice(1).toLowerCase();
  if(!['pdf','docx','txt','rtf'].includes(type))throw Error('Unsupported document type');
  if((await fs.stat(file)).size>30*1024*1024)throw Error('Choose a document smaller than 30 MB.');
  const data=await fs.readFile(file);let content;
  if(type==='pdf')content=data.toString('base64');
  else if(type==='txt')content=data.toString('utf8');
  else content=(await runDocumentJob({action:'open',type},data)).toString('utf8');
  current={file,type,data};return {name:path.basename(file),type,content};
 },
 async save(input){
  if(!current)throw Error('Open a document first.');
  const {file,type,data}=current;
  const choice=await dialog.showSaveDialog(getWindow(),{title:'Save edited copy',defaultPath:file.replace(/\.[^.]+$/,'')+' — edited.'+type,filters:[{name:type.toUpperCase(),extensions:[type]}]});
  if(choice.canceled)return null;
  if(path.resolve(choice.filePath)===path.resolve(file))throw Error('Choose a different filename to preserve the original.');
  let output;
  output=await runDocumentJob({action:'save',type,input},data);
  const flags=require('node:fs').constants;
  const destination=await fs.open(choice.filePath,flags.O_WRONLY|flags.O_CREAT|flags.O_NOFOLLOW,0o600);
  try{const [target,source]=await Promise.all([destination.stat(),fs.stat(file)]);if(!target.isFile() || target.nlink>1 || (target.dev===source.dev && target.ino===source.ino))throw Error('Choose a separate regular file to preserve the original.');await destination.truncate(0);await destination.writeFile(output);}finally{await destination.close();}
  return path.basename(choice.filePath);
 }
 };
}
module.exports={createDocuments};
