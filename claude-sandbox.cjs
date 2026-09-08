const path=require('node:path');
const os=require('node:os');
const {externalPath}=require('./bundle-paths.cjs');

function quote(value){return "'"+String(value).replaceAll("'","'\\''")+"'";}
function settings({root,mode,userData,home=os.homedir(),configDir=path.join(userData,'claude-config')}){
 if(!path.isAbsolute(root))throw Error('Claude sandbox requires an absolute workspace');
 const stateDir=path.join(userData,'claude-sandbox');
 const projectSlug=root.replace(/[^a-zA-Z0-9_-]/g,'-');
 const projectsDir=path.join(configDir,'projects'),projectDir=path.join(projectsDir,projectSlug);
 // Claude Code keeps its own state (login, history, settings, transcripts) in an app-owned config directory,
 // so a Chat session never sees the user's personal ~/.claude or ~/.claude.json.
 // Temporary files go to a private directory under the sandbox state (CLAUDE_CODE_TMPDIR), so /tmp stays denied.
 const allowWrite=[stateDir,configDir,projectDir];
 if(mode!=='readOnly')allowWrite.push(root);
 return {
  network:{allowedDomains:['api.anthropic.com','claude.ai','*.claude.ai'],deniedDomains:[],allowUnixSockets:[],allowLocalBinding:false},
  filesystem:{
   denyRead:[home,'/Users','/Volumes','/private/var/folders','/private/tmp','/tmp','/Library/Keychains',projectsDir,path.join(root,'**','.env'),path.join(root,'**','.env.*')],
   // The login token lives in the macOS Keychain; the security framework needs to locate the (encrypted) keychain database files to use it.
   allowRead:[root,configDir,projectDir,stateDir,path.join(home,'Library','Keychains')],
   allowWrite,
   denyWrite:[projectsDir,...(mode==='readOnly'?[root]:[])]
  },
  enableWeakerNestedSandbox:false,
  enableWeakerNetworkIsolation:false,
  allowAppleEvents:false
 };
}
async function prepareClaudeSandbox({fs,root,mode,userData,packageRoot,nodePath='/opt/homebrew/bin/node',claudePath='/opt/homebrew/bin/claude',configDir=path.join(userData,'claude-config'),home=os.homedir()}){
 const stateDir=path.join(userData,'claude-sandbox'),tmpDir=path.join(stateDir,'tmp');
 const settingsPath=path.join(stateDir,'settings.json');
 const probePath=path.join(stateDir,'claude-probe');
 const wrapperPath=path.join(stateDir,'claude-sandboxed');
 const cliPath=externalPath(path.join(packageRoot,'node_modules','@anthropic-ai','sandbox-runtime','dist','cli.js'));
 for(const dir of [stateDir,tmpDir,configDir])await fs.mkdir(dir,{recursive:true,mode:0o700});
 await fs.writeFile(settingsPath,JSON.stringify(settings({root,mode,userData,home,configDir}),null,2),{mode:0o600});
 // Fail closed: the probe runs inside the sandbox and refuses to start Claude if the home directory is still listable.
 const probe=`#!/bin/sh\nif /bin/ls ${quote(home)} >/dev/null 2>&1; then echo 'Just Zen: the Claude sandbox is not active. Refusing to start Claude.' >&2; exit 97; fi\nexec ${quote(claudePath)} "$@"\n`;
 await fs.writeFile(probePath,probe,{mode:0o700});await fs.chmod(probePath,0o700);
 const script=`#!/bin/sh\nCLAUDE_CONFIG_DIR=${quote(configDir)} CLAUDE_CODE_TMPDIR=${quote(tmpDir)} exec ${quote(nodePath)} ${quote(cliPath)} --settings ${quote(settingsPath)} -- ${quote(probePath)} "$@"\n`;
 await fs.writeFile(wrapperPath,script,{mode:0o700});await fs.chmod(wrapperPath,0o700);
 return {executable:wrapperPath,settingsPath,configDir};
}

module.exports={settings,prepareClaudeSandbox,quote};
