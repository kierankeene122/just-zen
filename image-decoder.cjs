const PNG_MAGIC=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
// Untrusted image bytes (website favicons) are decoded inside a hidden sandboxed renderer rather than the
// main process. Only a 32×32 PNG produced by that renderer comes back.
function createImageDecoder({BrowserWindow}){
 let window=null;
 async function ensure(){
  if(window && !window.isDestroyed())return window;
  window=new BrowserWindow({show:false,width:64,height:64,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'image-decoder'}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_c,_p,done)=>done(false));
  window.webContents.session.setPermissionCheckHandler(()=>false);
  await window.loadURL('about:blank');
  return window;
 }
 return async function decode(bytes){
  if(!Buffer.isBuffer(bytes) || !bytes.length || bytes.length>1024*1024)return null;
  const target=await ensure();
  const result=await target.webContents.executeJavaScript(`(async b64=>{try{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes]));const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d').drawImage(bitmap,0,0,32,32);bitmap.close();return canvas.toDataURL('image/png');}catch{return null;}})(${JSON.stringify(bytes.toString('base64'))})`,true);
  const prefix='data:image/png;base64,';
  if(typeof result!=='string' || !result.startsWith(prefix) || result.length>100000)return null;
  const png=Buffer.from(result.slice(prefix.length),'base64');
  return png.length>8 && PNG_MAGIC.equals(png.subarray(0,8))?png:null;
 };
}
module.exports={createImageDecoder,PNG_MAGIC};
