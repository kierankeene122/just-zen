const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('badge',{
  search:()=>ipcRenderer.send('pane-search'),
  close:()=>ipcRenderer.send('pane-close'),
  move:()=>ipcRenderer.send('pane-move'),
  split:()=>ipcRenderer.send('pane-split'),
  drag:d=>ipcRenderer.send('pane-drag',{dx:Number(d?.dx)||0,dy:Number(d?.dy)||0,done:d?.done===true}),
  onTheme:fn=>ipcRenderer.on('badge-theme',(_e,theme)=>fn(theme==='dark'?'dark':'light')),
  onLabelled:fn=>ipcRenderer.on('badge-labelled',(_e,on)=>fn(on===true))
});
