// Cut a signed release on demand:  npm run release            (patch: 0.3.4 -> 0.3.5)
//                                  npm run release -- minor   (0.3.4 -> 0.4.0)
// Bumps the version, commits, tags, and pushes; the tag triggers the signed macOS build on GitHub.
const {execFileSync}=require('node:child_process');
const kind=process.argv[2] || 'patch';
if(!['patch','minor','major'].includes(kind))throw Error('Use patch, minor or major');
const run=(cmd,args)=>execFileSync(cmd,args,{stdio:['ignore','pipe','inherit'],encoding:'utf8'}).trim();
if(run('git',['status','--porcelain']))throw Error('Commit or stash your changes first; the release must come from a clean tree.');
run('git',['pull','--rebase','--quiet','origin','main']);
const version=run('npm',['version',kind,'--no-git-tag-version']);
run('git',['commit','-qam',`chore(release): ${version}`]);
run('git',['tag',version]);
run('git',['push','--quiet','origin','main',version]);
console.log(`Tagged ${version}. The signed build is running: https://github.com/kierankeene122/just-zen/actions`);
