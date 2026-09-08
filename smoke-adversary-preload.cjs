const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('probe',{invoke:(channel,...args)=>ipcRenderer.invoke(channel,...args)});
