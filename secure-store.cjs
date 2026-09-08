const path=require('node:path');

function createSecureStore({fs,safeStorage,userData}){
 const encryptedPath=path.join(userData,'workspace.secure');
 const legacyPath=path.join(userData,'workspace.json');
 function available(){return Boolean(safeStorage?.isEncryptionAvailable?.());}
 async function save(value){
  if(!available())throw Error('macOS Keychain encryption is unavailable');
  await fs.mkdir(userData,{recursive:true});
  const payload=safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  await fs.writeFile(encryptedPath+'.tmp',payload,{mode:0o600});
  await fs.rename(encryptedPath+'.tmp',encryptedPath);
 }
 async function load(){
  try{
   if(!available())throw Error('macOS Keychain encryption is unavailable');
   const payload=await fs.readFile(encryptedPath,'utf8');
   return JSON.parse(safeStorage.decryptString(Buffer.from(payload,'base64')));
  }catch(error){
   if(error.code!=='ENOENT' && !/Keychain encryption is unavailable/.test(error.message))throw Error('Just Zen could not decrypt its local state. The Keychain entry may be unavailable.');
  }
  try{
   const legacy=JSON.parse(await fs.readFile(legacyPath,'utf8'));
   await save(legacy);
   await fs.unlink(legacyPath).catch(()=>{});
   return legacy;
  }catch(error){if(error.code!=='ENOENT')throw error;return {};}
 }
 return {load,save,available,encryptedPath,legacyPath};
}

module.exports={createSecureStore};
