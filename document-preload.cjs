const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('documents',{call:(name,...args)=>{if(!['document-open','document-save','document-close'].includes(name))throw Error('Document action denied');return ipcRenderer.invoke(name,...args);},collapse:()=>ipcRenderer.send('document-collapse')});
