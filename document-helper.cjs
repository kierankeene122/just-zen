const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const {findNode}=require('./node-runtime.cjs');
const {externalPath}=require('./bundle-paths.cjs');
const q=value=>JSON.stringify(value);
const worker=externalPath(path.join(__dirname,'document-worker.cjs')),sanitizer=externalPath(path.join(__dirname,'document-sanitize.cjs')),slides=externalPath(path.join(__dirname,'pptx.cjs'));
function profile(job){return `(version 1)
(deny default)
(allow process* sysctl-read mach-lookup)
(allow file-read-metadata)
(allow file-read* (subpath "/opt/homebrew") (subpath "/System") (subpath "/usr") (subpath "/Library") (subpath "/private/var/db") (subpath "/dev") (literal "/") (literal "/private") (literal "/private/tmp") (literal "/private/var") (literal "/private/var/folders") (subpath ${q(path.dirname(path.dirname(process.execPath)))}) (subpath ${q(externalPath(path.join(__dirname,'node_modules')))}) (literal ${q(externalPath(path.join(__dirname,'package.json')))}) (literal ${q(worker)}) (literal ${q(sanitizer)}) (literal ${q(slides)}))
(allow file-read* file-write* (subpath ${q(job)}))
`;}
async function runDocumentJob(request,data){
 // Word and RTF go through macOS textutil inside a Seatbelt sandbox. Presentations are parsed by pure JavaScript, so on
 // Windows they run in a plain child process (no OS sandbox there) with the same job directory, timeout and size cap.
 const plain=process.platform!=='darwin';
 if(plain && request.type!=='pptx')throw Error('Opening Word and RTF files needs macOS for now. PDF, PowerPoint and text work everywhere.');
 const job=await fs.mkdtemp(path.join(plain?os.tmpdir():'/private/tmp','zen-convert-'));
 try{
  await fs.writeFile(path.join(job,'input'),data);await fs.writeFile(path.join(job,'source.'+request.type),data);
  await fs.writeFile(path.join(job,'request.json'),JSON.stringify(request));await fs.writeFile(path.join(job,'sandbox.sb'),profile(job));
  if(plain)await exec(findNode(),[worker,job],{env:{PATH:process.env.PATH || '',HOME:job,TMPDIR:job,TEMP:job,TMP:job},timeout:30000,maxBuffer:1024*1024});
  else await exec('/usr/bin/sandbox-exec',['-f',path.join(job,'sandbox.sb'),findNode(),worker,job],{env:{PATH:'/usr/bin:/bin',HOME:job,TMPDIR:job},timeout:30000,maxBuffer:1024*1024});
  const out=path.join(job,'output');if((await fs.stat(out)).size>50*1024*1024)throw Error('Converted document is too large');return await fs.readFile(out);
 }finally{await fs.rm(job,{recursive:true,force:true});}
}
module.exports={runDocumentJob,profile};
