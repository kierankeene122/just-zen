// Refuses to auto-merge a Dependabot branch that bumps any dependency or pinned action across a major version.
// Usage: node .github/scripts/check-dependency-update.cjs <git ref of the PR head>   (compares against origin/main)
const {execFileSync}=require('node:child_process');
const head=process.argv[2];if(!head)throw Error('Pass the PR head ref');
const show=(ref,file)=>{try{return execFileSync('git',['show',`${ref}:${file}`],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{return null;}};
const major=v=>String(v).replace(/^[^\d]*/,'').split('.')[0];
const problems=[];
const before=JSON.parse(show('origin/main','package-lock.json') || '{}').packages || {},after=JSON.parse(show(head,'package-lock.json') || '{}').packages || {};
for(const [name,entry] of Object.entries(after)){const old=before[name];if(old && old.version && entry.version && old.version!==entry.version){console.log(`${name}: ${old.version} -> ${entry.version}`);if(major(old.version)!==major(entry.version))problems.push(`${name} changes major version ${old.version} -> ${entry.version}`);}}
const files=execFileSync('git',['diff','--name-only',`origin/main...${head}`],{encoding:'utf8'}).split('\n').filter(f=>/^\.github\/workflows\/.*\.ya?ml$/.test(f));
for(const file of files){const pins=text=>Object.fromEntries([...(text || '').matchAll(/uses:\s*([^@\s]+)@\S+\s*#\s*v?(\d+)/g)].map(m=>[m[1],m[2]]));const a=pins(show('origin/main',file)),b=pins(show(head,file));for(const [action,version] of Object.entries(b))if(a[action] && a[action]!==version){console.log(`${action}: v${a[action]} -> v${version}`);problems.push(`${action} changes major version v${a[action]} -> v${version}`);}}
if(problems.length){console.error('Not auto-merging:\n - '+problems.join('\n - '));process.exit(1);}
console.log('Only patch or minor updates; safe to auto-merge.');
