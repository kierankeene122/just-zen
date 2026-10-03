// Upgrading from the version with panes: the web apps someone had configured become the first things on the panel,
// so it is never empty for a person who had already set Just Zen up. It happens once, and only when there is
// something to carry over — an empty first run must not mark the job done.
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}}

function seedPins({pins=[],services=[],seeded=false,limit=12}={}){
  if(Array.isArray(pins) && pins.length)return {pins,seeded,changed:false};
  if(seeded)return {pins:[],seeded,changed:false};
  const saved=(Array.isArray(services)?services:[]).filter(item=>item && typeof item.url==='string' && /^https?:/i.test(item.url)).slice(0,limit);
  if(!saved.length)return {pins:[],seeded:false,changed:false};
  return {
    pins:saved.map(item=>({id:'web:'+item.url,kind:'web',label:String(item.name || hostOf(item.url)).slice(0,80),detail:hostOf(item.url),target:item.url,icon:'',glyph:'◐',folder:''})),
    seeded:true,
    changed:true
  };
}
module.exports={seedPins};
