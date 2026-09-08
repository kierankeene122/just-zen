const test=require('node:test'),assert=require('node:assert/strict');
const {reorder,createFolder,setFolder}=require('./sidebar.cjs');
const {createFaviconCache}=require('./favicons.cjs');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('custom sites discover relative icons from HTML and omit credentials',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zen-custom-icons-'));
 try{
  const calls=[];
  const net={fetch:async(url,options)=>{calls.push(url);assert.equal(options.credentials,'omit');return calls.length===1 ? new Response('<head><link rel="icon" href="/assets/logo.png"></head>',{headers:{'content-type':'text/html'}}) : new Response(new Uint8Array([1,2,3]));}};
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('png')]),decode=async()=>png;
  assert.equal(await createFaviconCache(dir,net,decode)('https://example.com/app'),'data:image/png;base64,'+png.toString('base64'));
  assert.deepEqual(calls,['https://example.com/app','https://example.com/assets/logo.png']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('reordering retains all service details and rejects stale or duplicate orders',()=>{const items=[{id:'a',name:'A'},{url:'https://b.com',name:'B'}];assert.deepEqual(reorder(items,['https://b.com','a']),[items[1],items[0]]);assert.throws(()=>reorder(items,['a','a']));assert.throws(()=>reorder(items,['a']));assert.equal(items[0].id,'a');});
test('folders group apps without losing their saved details',()=>{const folders=createFolder([],'Work','folder-1');const items=[{id:'mail',name:'Mail',url:'https://mail.example'}];const grouped=setFolder(items,'mail','folder-1',folders);assert.equal(grouped[0].folderId,'folder-1');assert.equal(grouped[0].url,items[0].url);assert.equal(setFolder(grouped,'mail',null,folders)[0].folderId,null);assert.throws(()=>setFolder(items,'mail','missing',folders));});
test('favicon is discovered, saved, and available in a new cache instance offline',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hearth-icons-'));try{let calls=0;const net={fetch:async()=>{calls++;return new Response(new Uint8Array([1,2,3]));}};const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('png')]),expected='data:image/png;base64,'+png.toString('base64');let decoded=0;const decode=async()=>{decoded++;return png;};const cache=createFaviconCache(dir,net,decode);assert.equal(await cache('https://example.com/app'),expected);const offline=createFaviconCache(dir,{fetch:()=>{throw Error('offline');}},decode);assert.equal(await offline('https://example.com/other'),expected);assert.equal(calls,2);assert.equal(decoded,1);const rejecting=createFaviconCache(await fs.mkdtemp(path.join(os.tmpdir(),'hearth-icons-bad-')),net,async()=>Buffer.from('not a png'));assert.equal(await rejecting('https://example.com/app'),null);}finally{await fs.rm(dir,{recursive:true,force:true});}});
