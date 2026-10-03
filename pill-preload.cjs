const {contextBridge,ipcRenderer,webUtils}=require('electron');
// The pill can open one of its own pins, drop files on one, and open the two fixed buttons. Nothing reads the page.
contextBridge.exposeInMainWorld('pill',{
  ready:()=>ipcRenderer.send('pill-ready'),
  open:id=>ipcRenderer.send('pill-open',String(id || '').slice(0,2000)),
  menu:id=>ipcRenderer.send('pill-menu',String(id || '').slice(0,2000)),
  drop:(id,files)=>ipcRenderer.send('pill-drop',{id:String(id || '').slice(0,2000),files:(Array.isArray(files)?files:[]).slice(0,10).map(f=>String(f).slice(0,4000))}),
  flick:()=>ipcRenderer.send('pill-flick'),
  add:()=>ipcRenderer.send('pill-add'),
  home:()=>ipcRenderer.send('pill-home'),
  pathFor:file=>{try{return webUtils.getPathForFile(file);}catch{return '';}},
  onPins:fn=>ipcRenderer.on('pill-pins',(_e,pins)=>fn(pins)),
  onBadges:fn=>ipcRenderer.on('pill-badges',(_e,map)=>fn(map)),
  onTheme:fn=>ipcRenderer.on('pill-theme',(_e,theme)=>fn(theme==='dark'?'dark':'light'))
});
