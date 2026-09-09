// Electron supports its three newest major versions: a major stops receiving Chromium fixes when the third major
// after it ships. This computes that date for the Electron a build carries, from releases.electronjs.org.
//   node scripts/electron-support.cjs            prints the support window for the installed Electron
//   node scripts/electron-support.cjs --check    exits 1 when fewer than 30 days remain (for CI)
const WEEKS_PER_MAJOR=8;
function firstStableDates(releases){const out={};for(const r of releases){if(r.version.includes('-'))continue;const [major,minor,patch]=r.version.split('.').map(Number);if(minor===0&&patch===0&&!out[major])out[major]=r.date;}return out;}
function supportWindow(version,releases,now=new Date()){
 const major=Number(String(version).split('.')[0]);const dates=firstStableDates(releases);
 const released=dates[major];if(!released)return null;
 const successor=dates[major+3];
 const ends=successor?new Date(successor):new Date(new Date(released).getTime()+3*WEEKS_PER_MAJOR*7*86400000);
 return {major,released,supportEnds:ends.toISOString().slice(0,10),estimated:!successor,daysLeft:Math.round((ends-now)/86400000)};
}
async function fetchReleases(){const res=await fetch('https://releases.electronjs.org/releases.json');if(!res.ok)throw Error('releases.json HTTP '+res.status);return res.json();}
async function electronSupport(version){return supportWindow(version,await fetchReleases());}
module.exports={supportWindow,electronSupport,firstStableDates};
if(require.main===module){(async()=>{
 const version=require('electron/package.json').version;const w=await electronSupport(version);
 console.log(JSON.stringify({electron:version,...w}));
 if(process.argv.includes('--check')&&w&&w.daysLeft<30){console.error(`Electron ${w.major} stops receiving Chromium fixes on ${w.supportEnds}${w.estimated?' (estimated)':''}: upgrade the major.`);process.exit(1);}
})().catch(e=>{console.error(e.message);process.exit(2);});}
