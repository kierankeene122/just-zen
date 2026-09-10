function reorder(items,keys){
 const key=s=>s.id || s.url;
 if(!Array.isArray(keys)||keys.length!==items.length||new Set(keys).size!==items.length||keys.some(k=>!items.some(s=>key(s)===k)))throw Error('Invalid sidebar order');
 return keys.map(k=>items.find(s=>key(s)===k));
}
// An icon is either a short emoji string or 'ms:<name>' pointing at the bundled Material Symbols subset.
function cleanIcon(icon){const value=typeof icon==='string'?icon.trim():'';if(/^ms:[a-z0-9-]{1,60}$/.test(value))return value;return [...value].slice(0,4).join('') || '◫';}
function createFolder(folders,name,id,icon){
 if(typeof name!=='string' || !name.trim())throw Error('Group name is required');
 return [...folders,{id,name:name.trim().slice(0,40),icon:cleanIcon(icon),collapsed:true}];
}
function updateFolder(folders,id,{name,icon}={}){
 let found=false;
 const next=folders.map(folder=>{if(folder.id!==id)return folder;found=true;const out={...folder};if(typeof name==='string' && name.trim())out.name=name.trim().slice(0,40);if(icon!==undefined)out.icon=cleanIcon(icon);return out;});
 if(!found)throw Error('Group not found');
 return next;
}
function removeFolder(items,folders,id){
 if(!folders.some(folder=>folder.id===id))throw Error('Group not found');
 return {folders:folders.filter(folder=>folder.id!==id),services:items.map(item=>item.folderId===id?{...item,folderId:null}:item)};
}
function setFolder(items,key,folderId,folders){
 if(folderId && !folders.some(folder=>folder.id===folderId))throw Error('Group not found');
 let found=false;
 const next=items.map(item=>{if((item.id || item.url)!==key)return item;found=true;return {...item,folderId:folderId || null};});
 if(!found)throw Error('App not found');
 return next;
}
module.exports={reorder,createFolder,updateFolder,removeFolder,setFolder,cleanIcon};
