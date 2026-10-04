const {contextBridge,ipcRenderer,webUtils}=require('electron');
// The pill can open one of its own pins, drop files on one, and open the two fixed buttons. Nothing reads the page.
contextBridge.exposeInMainWorld('pill',{
  ready:()=>ipcRenderer.send('pill-ready'),
  open:id=>ipcRenderer.send('pill-open',String(id || '').slice(0,2000)),
  menu:id=>ipcRenderer.send('pill-menu',String(id || '').slice(0,2000)),
  drop:(id,files)=>ipcRenderer.send('pill-drop',{id:String(id || '').slice(0,2000),files:(Array.isArray(files)?files:[]).slice(0,10).map(f=>String(f).slice(0,4000))}),
  flick:()=>ipcRenderer.send('pill-flick'),
  add:()=>ipcRenderer.send('pill-add'),
  order:ids=>ipcRenderer.send('pill-order',(Array.isArray(ids)?ids:[]).slice(0,40).map(id=>String(id).slice(0,2000))),
  group:(id,folder)=>ipcRenderer.send('pill-group',{id:String(id || '').slice(0,2000),folder:String(folder || '').slice(0,40)}),
  update:()=>ipcRenderer.send('pill-update'),
  onUpdate:fn=>ipcRenderer.on('pill-update',(_e,payload)=>fn(payload || {})),
  onAskGroup:fn=>ipcRenderer.on('pill-ask-group',(_e,payload)=>fn(payload && payload.id)),
  home:()=>ipcRenderer.send('pill-home'),
  pathFor:file=>{try{return webUtils.getPathForFile(file);}catch{return '';}},
  onPins:fn=>ipcRenderer.on('pill-pins',(_e,pins)=>fn(pins)),
  onBadges:fn=>ipcRenderer.on('pill-badges',(_e,map)=>fn(map)),
  onTheme:fn=>ipcRenderer.on('pill-theme',(_e,theme)=>fn(theme==='dark'?'dark':'light'))
});
