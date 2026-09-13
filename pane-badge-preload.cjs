const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('badge',{
  search:()=>ipcRenderer.send('pane-search'),
  close:()=>ipcRenderer.send('pane-close'),
  move:()=>ipcRenderer.send('pane-move'),
  onTheme:fn=>ipcRenderer.on('badge-theme',(_e,theme)=>fn(theme==='dark'?'dark':'light')),
  onLabelled:fn=>ipcRenderer.on('badge-labelled',(_e,on)=>fn(on===true))
});
