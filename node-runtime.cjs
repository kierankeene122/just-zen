const fs=require('node:fs');
const path=require('node:path');
// Helper processes run under a real Node.js binary so the Electron binary never needs ELECTRON_RUN_AS_NODE,
// which lets the RunAsNode fuse stay off in packaged builds.
function findNode({resourcesPath=process.resourcesPath,candidates=['/opt/homebrew/bin/node','/usr/local/bin/node']}={}){
 // Under plain Node (tests, CI) the current executable is already Node; under Electron it is not.
 const self=process.versions.electron?[]:[process.execPath];
 const list=[...self,...(resourcesPath?[path.join(resourcesPath,'node')]:[]),...candidates];
 for(const candidate of list){try{fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile())return candidate;}catch{}}
 throw Error('Just Zen needs Node.js for its sandboxed helpers. Install it with "brew install node" and try again.');
}
module.exports={findNode};
