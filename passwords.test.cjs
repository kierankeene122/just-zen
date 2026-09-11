const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createPasswordVault}=require('./passwords.cjs');
const safeStorage={isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from('enc:'+v),decryptString:b=>b.toString().replace(/^enc:/,'')};
test('logins are stored encrypted, matched by exact origin, and honour never-for-this-site',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zen-pw-'));
 try{
  const vault=createPasswordVault({fs,safeStorage,userData:dir});
  await vault.set('https://app.example.com/login?next=1','kieran','hunter2');
  assert.equal((await vault.get('https://app.example.com/other')).password,'hunter2');
  assert.equal(await vault.get('https://example.com/'),null,'a different host does not match');
  assert.equal(await vault.get('http://app.example.com/'),null,'a different scheme does not match');
  assert.ok(!String(await fs.readFile(vault.file)).includes('hunter2'),'the file never holds the plaintext');
  const fresh=createPasswordVault({fs,safeStorage,userData:dir});
  assert.equal((await fresh.get('https://app.example.com/')).username,'kieran');
  assert.deepEqual((await fresh.list()).map(e=>e.origin),['https://app.example.com']);
  await fresh.never('https://app.example.com/');
  assert.equal(await fresh.get('https://app.example.com/'),null);assert.equal(await fresh.isNever('https://app.example.com/x'),true);
  await assert.rejects(fresh.set('file:///etc/passwd','a','b'));
  await fresh.set('https://app.example.com/','kieran','again');assert.equal(await fresh.isNever('https://app.example.com/'),false,'saving again lifts never');
  await fresh.clear();assert.equal(await fresh.get('https://app.example.com/'),null);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
