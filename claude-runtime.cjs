const fs=require('node:fs');
const path=require('node:path');
const {externalPath}=require('./bundle-paths.cjs');
// Claude Code ships inside the app (the Agent SDK's signed native binary), so nothing on the machine can substitute it.
// A Homebrew or /usr/local install is only a fallback for development checkouts without the platform package.
function findClaude({packageRoot=__dirname,candidates=['/opt/homebrew/bin/claude','/usr/local/bin/claude']}={}){
 const bundled=externalPath(path.join(packageRoot,'node_modules','@anthropic-ai','claude-agent-sdk-darwin-arm64','claude'));
 for(const candidate of [bundled,...candidates]){try{fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile())return candidate;}catch{}}
 throw Error('Claude Code was not found. Reinstall Just Zen, or install Claude Code with "npm install -g @anthropic-ai/claude-code".');
}
module.exports={findClaude};
