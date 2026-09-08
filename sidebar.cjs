function reorder(items,keys){
 const key=s=>s.id || s.url;
 if(!Array.isArray(keys)||keys.length!==items.length||new Set(keys).size!==items.length||keys.some(k=>!items.some(s=>key(s)===k)))throw Error('Invalid sidebar order');
 return keys.map(k=>items.find(s=>key(s)===k));
}
function createFolder(folders,name,id){
 if(typeof name!=='string' || !name.trim())throw Error('Folder name is required');
 return [...folders,{id,name:name.trim().slice(0,40),collapsed:false}];
}
function setFolder(items,key,folderId,folders){
 if(folderId && !folders.some(folder=>folder.id===folderId))throw Error('Folder not found');
 let found=false;
 const next=items.map(item=>{if((item.id || item.url)!==key)return item;found=true;return {...item,folderId:folderId || null};});
 if(!found)throw Error('App not found');
 return next;
}
module.exports={reorder,createFolder,setFolder};
