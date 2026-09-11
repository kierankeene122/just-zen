const path=require('node:path');
// Saved logins, one file, encrypted with the macOS Keychain-backed safeStorage. Keyed by exact origin (scheme, host, port).
function createPasswordVault({fs,safeStorage,userData}){
 const file=path.join(userData,'passwords.secure');
 let vault=null;
 function available(){return Boolean(safeStorage?.isEncryptionAvailable?.());}
 async function load(){if(vault)return vault;try{if(!available())throw Error('unavailable');vault=JSON.parse(safeStorage.decryptString(Buffer.from(await fs.readFile(file,'utf8'),'base64')));}catch(error){if(error.code!=='ENOENT' && !/unavailable/.test(error.message))throw Error('Saved passwords could not be decrypted.');vault={entries:[],never:[]};}vault.entries=Array.isArray(vault.entries)?vault.entries:[];vault.never=Array.isArray(vault.never)?vault.never:[];return vault;}
 async function save(){if(!available())throw Error('macOS Keychain encryption is unavailable');await fs.mkdir(userData,{recursive:true});await fs.writeFile(file+'.tmp',safeStorage.encryptString(JSON.stringify(vault)).toString('base64'),{mode:0o600});await fs.rename(file+'.tmp',file);}
 function originOf(url){try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))return null;return u.origin;}catch{return null;}}
 async function get(url){const origin=originOf(url);if(!origin)return null;const v=await load();const matches=v.entries.filter(e=>e.origin===origin).sort((a,b)=>(b.usedAt || 0)-(a.usedAt || 0));return matches[0] || null;}
 async function list(){const v=await load();return v.entries.map(e=>({origin:e.origin,username:e.username,savedAt:e.savedAt})).sort((a,b)=>a.origin.localeCompare(b.origin));}
 async function isNever(url){const origin=originOf(url);const v=await load();return Boolean(origin && v.never.includes(origin));}
 async function set(url,username,password){const origin=originOf(url);if(!origin)throw Error('Only web logins can be saved');if(typeof username!=='string' || typeof password!=='string' || !password || password.length>1000 || username.length>300)throw Error('Invalid login');const v=await load();const now=Date.now();const existing=v.entries.find(e=>e.origin===origin && e.username===username);if(existing){existing.password=password;existing.savedAt=now;existing.usedAt=now;}else v.entries.push({origin,username,password,savedAt:now,usedAt:now});v.never=v.never.filter(o=>o!==origin);await save();return true;}
 async function touch(url,username){const v=await load();const e=v.entries.find(x=>x.origin===originOf(url) && x.username===username);if(e){e.usedAt=Date.now();await save();}}
 async function remove(origin,username){const v=await load();const before=v.entries.length;v.entries=v.entries.filter(e=>!(e.origin===origin && e.username===username));if(v.entries.length!==before)await save();return v.entries.length!==before;}
 async function never(url){const origin=originOf(url);if(!origin)return false;const v=await load();if(!v.never.includes(origin))v.never.push(origin);v.entries=v.entries.filter(e=>e.origin!==origin);await save();return true;}
 async function clear(){vault={entries:[],never:[]};await fs.rm(file,{force:true});}
 return {load,get,list,set,touch,remove,never,isNever,clear,originOf,available,file};
}
module.exports={createPasswordVault};
