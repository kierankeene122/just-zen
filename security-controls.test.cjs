const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {settings,quote}=require('./claude-sandbox.cjs');
const {createSecureStore}=require('./secure-store.cjs');

test('Claude sandbox denies the home directory and only writes the selected workspace',()=>{
 const root='/Users/person/Vault',home='/Users/person';
 const full=settings({root,mode:'full',userData:'/Users/person/Library/Hearth',home});
 assert.equal(full.filesystem.denyRead[0],home);
 for(const blocked of ['/Users','/Volumes','/private/var/folders','/private/tmp','/tmp'])assert(full.filesystem.denyRead.includes(blocked),blocked);
 assert(full.filesystem.denyRead.some(value=>value.endsWith('/claude-config/projects')));
 assert(full.filesystem.allowRead.includes(root));
 assert(!full.filesystem.allowRead.some(value=>value.startsWith(home+'/.claude')),'the personal ~/.claude is never shared with Chat');
 assert(full.filesystem.allowRead.includes('/Users/person/Library/Hearth/claude-config'));
 assert(!full.filesystem.allowWrite.includes('/private/tmp'));
 assert(full.filesystem.allowWrite.includes(root));
 assert.equal(full.network.allowLocalBinding,false);
 assert.equal(full.allowAppleEvents,false);
 const readOnly=settings({root,mode:'readOnly',userData:'/Users/person/Library/Hearth',home});
 assert(!readOnly.filesystem.allowWrite.includes(root));
 assert(readOnly.filesystem.denyWrite.includes(root));assert(!full.filesystem.denyWrite.includes(root));
});

test('sandbox wrapper quoting cannot execute interpolated shell text',()=>{
  assert.equal(quote("a'b$(touch /tmp/nope)"),"'a'\\''b$(touch /tmp/nope)'");
});

test('secure store encrypts state and migrates the legacy plaintext file',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hearth-secure-store-'));
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('protected:'+value),decryptString:value=>value.toString().replace(/^protected:/,'')};
 const store=createSecureStore({fs,safeStorage,userData:dir});
 await fs.writeFile(store.legacyPath,JSON.stringify({tasks:['private']}));
 assert.deepEqual(await store.load(),{tasks:['private']});
 await assert.rejects(fs.access(store.legacyPath));
 assert(!String(await fs.readFile(store.encryptedPath)).includes('private'));
 assert.deepEqual(await store.load(),{tasks:['private']});
});

test('local updater state is summarised for the Security page',()=>{
 const {describeUpdateState}=require('./update-state.cjs');
 assert.match(describeUpdateState(null),/not run yet/);
 assert.match(describeUpdateState({checkedAt:'2026-09-08T09:30:00Z',status:'current',latest:'44.2.0'}),/44\.2\.0 current/);
 assert.match(describeUpdateState({checkedAt:'2026-09-08T09:30:00Z',staged:true,stagedElectron:'44.2.1'}),/quit Just Zen to install/);
 assert.match(describeUpdateState({checkedAt:'2026-09-08T09:30:00Z',status:'failed'}),/failed/);
 assert.match(describeUpdateState({checkedAt:'2026-09-08T09:30:00Z',status:'current',latest:'44.2.0',newerMajor:'45.0.0'}),/45\.0\.0 available/);
});
