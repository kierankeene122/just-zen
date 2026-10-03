const {contextBridge,ipcRenderer}=require('electron');
// The flick bar can ask for results and open one of them. Nothing else crosses this bridge.
contextBridge.exposeInMainWorld('flick',{
  search:payload=>ipcRenderer.invoke('flick-search',{query:String(payload?.query || '').slice(0,200),stage:payload?.stage==='slow'?'slow':'fast',mode:payload?.mode==='pin'?'pin':'open'}),
  open:(item,pin)=>ipcRenderer.invoke('flick-open',{id:String(item?.id || '').slice(0,2000),pin:pin===true}),
  close:()=>ipcRenderer.send('flick-close'),
  onShow:fn=>ipcRenderer.on('flick-show',(_e,payload)=>fn(payload && payload.mode==='pin'?'pin':'open')),
  onTheme:fn=>ipcRenderer.on('flick-theme',(_e,theme)=>fn(theme==='dark'?'dark':'light'))
});
