const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {PNG_MAGIC}=require('./image-decoder.cjs');
// decode(bytes) must turn untrusted image bytes into a 32×32 PNG outside the main process, or return null.
function createFaviconCache(directory,net,decode){
 const pending=new Map(),memory=new Map();
 return async function icon(site,candidate){
  const origin=new URL(site).origin;
  const cached=memory.get(origin);if(cached && (!candidate || cached.candidate===candidate))return cached.icon;
  const file=path.join(directory,createHash('sha256').update(origin).digest('hex')+'.png');
  if(!candidate){try{const icon='data:image/png;base64,'+(await fs.readFile(file)).toString('base64');memory.set(origin,{icon,candidate:null});return icon;}catch{}}
  if(pending.has(origin))return pending.get(origin);
  const known=new Map([
   ['mail.google.com','https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico'],
   ['calendar.google.com','https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png'],
   ['drive.google.com','https://ssl.gstatic.com/images/branding/product/2x/hh_drive_96dp.png']
  ]);
  const candidates=[candidate,known.get(new URL(site).hostname),new URL('/favicon.ico',origin).href].filter(Boolean);
  const work=(async()=>{
  if(!candidate)try{
   const response=await net.fetch(site,{credentials:'omit',signal:AbortSignal.timeout(5000)});
   if(response.ok && response.headers?.get('content-type')?.includes('text/html')){
    const reader=response.body.getReader();let html='',bytes=0;const decoder=new TextDecoder();
    while(bytes<128*1024){const part=await reader.read();if(part.done)break;bytes+=part.value.length;html+=decoder.decode(part.value,{stream:true});if(/<\/head>/i.test(html))break;}await reader.cancel();
    for(const tag of html.match(/<link\b[^>]*>/gi) || []){
     const rel=tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1];
     const href=tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
     if(rel && /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(rel) && href)candidates.unshift(new URL(href.replace(/&amp;/g,'&'),response.url || site).href);
    }
   }
  }catch{}
  for(const value of [...new Set(candidates)])try{
   const url=new URL(value,origin);if(!['https:','http:'].includes(url.protocol))continue;
   const response=await net.fetch(url.href,{credentials:'omit',signal:AbortSignal.timeout(8000)});if(!response.ok)continue;
   const reader=response.body.getReader();let size=0;const chunks=[];
   while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();break;}chunks.push(Buffer.from(value));}
   if(size>1024*1024)continue;const png=await decode(Buffer.concat(chunks));if(!png || png.length<=8 || !PNG_MAGIC.equals(png.subarray(0,8)))continue;
   await fs.mkdir(directory,{recursive:true});await fs.writeFile(file,png);
   const icon='data:image/png;base64,'+png.toString('base64');memory.set(origin,{icon,candidate});return icon;
  }catch{}return null;})();pending.set(origin,work);try{return await work;}finally{pending.delete(origin);}
 };
}
module.exports={createFaviconCache};
