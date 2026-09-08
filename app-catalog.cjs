const catalogue = require('./web-apps.json');
const byId = new Map(catalogue.map(app => [app.id, app]));
function canonical(url) {
  try { const parsed = new URL(url); return parsed.href.replace(/\/$/, ''); } catch { return ''; }
}
function findApp(id) {
  const app = byId.get(id);
  if (!app) throw new Error('This app is not in the library.');
  return app;
}
function isAdded(services, app) {
  return services.some(service => service.id === app.id || (service.url && canonical(service.url) === canonical(app.url)));
}
function addApp(services, id) {
  const app = findApp(id);
  if (isAdded(services, app)) return services;
  return [...services, {id:app.id, name:app.name, kind:'web', url:app.url, profile:'isolated'}];
}
function bundledIcon(service){
 if(!service?.url)return null;
 try{
  const url=new URL(service.url),host=url.hostname.replace(/^www\./,'');
  const matches=catalogue.filter(app=>new URL(app.url).hostname.replace(/^www\./,'')===host);
  const exact=matches.find(app=>app.id===service.id);if(exact)return exact.icon;
  return matches.filter(app=>{const base=new URL(app.url).pathname.replace(/\/$/,'');return !base || url.pathname===base || url.pathname.startsWith(base+'/');}).sort((a,b)=>new URL(b.url).pathname.length-new URL(a.url).pathname.length)[0]?.icon || null;
 }catch{return null;}
}
module.exports = {catalogue, findApp, isAdded, addApp, bundledIcon};
