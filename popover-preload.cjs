const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('popover',{
  send:(name,value)=>{if(!['popover-open','popover-edit','popover-remove','popover-close','popover-size'].includes(name))throw Error('Popover action denied');ipcRenderer.send(name,value);},
  onShow:fn=>ipcRenderer.on('popover-show',(_e,data)=>fn(data))
});
