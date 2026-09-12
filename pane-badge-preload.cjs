const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('badge',{
  search:()=>ipcRenderer.send('pane-search'),
  close:()=>ipcRenderer.send('pane-close'),
  onTheme:fn=>ipcRenderer.on('badge-theme',(_e,theme)=>fn(theme==='dark'?'dark':'light'))
});
