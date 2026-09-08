// Installs (or refreshes) the launchd agent that runs the local Electron updater daily and at login.
//   node scripts/install-update-agent.cjs          # install
//   node scripts/install-update-agent.cjs --remove # remove
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const label='com.hearth.justzen.update',root=path.resolve(__dirname,'..');
const plist=path.join(os.homedir(),'Library','LaunchAgents',label+'.plist'),logs=path.join(os.homedir(),'Library','Logs','Just Zen');
const node=['/opt/homebrew/bin/node','/usr/local/bin/node'].find(p=>fs.existsSync(p));
if(!node)throw Error('Node.js not found in /opt/homebrew/bin or /usr/local/bin');
const domain='gui/'+process.getuid();
spawnSync('launchctl',['bootout',domain+'/'+label],{stdio:'ignore'});
if(process.argv.includes('--remove')){fs.rmSync(plist,{force:true});console.log('Removed',label);process.exit(0);}
fs.mkdirSync(path.dirname(plist),{recursive:true});fs.mkdirSync(logs,{recursive:true});
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
fs.writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(path.join(root,'scripts','update-electron.cjs'))}</string></array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>${esc(os.homedir())}</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(logs,'update-agent.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logs,'update-agent.log'))}</string>
</dict></plist>
`);
const result=spawnSync('launchctl',['bootstrap',domain,plist],{encoding:'utf8'});
if(result.status!==0)throw Error('launchctl bootstrap failed: '+(result.stderr || result.stdout));
console.log('Installed',label,'— runs daily at 09:30 and at login. Log:',path.join(logs,'update.log'));
