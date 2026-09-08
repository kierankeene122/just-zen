const path=require('node:path');

const SAFE_READ_TOOLS=new Set(['Read','Glob','Grep','WebFetch','WebSearch','AskUserQuestion','TodoRead','TodoWrite']);
const WRITE_TOOLS=new Set(['Write','Edit','MultiEdit','NotebookEdit']);
const MARKDOWN=/\.(md|markdown)$/i;

function pathsFromInput(input,tool=''){
 if(!input || typeof input!=='object')return [];
 const keys=['file_path','path','notebook_path','directory'];
 const targets=keys.flatMap(key=>typeof input[key]==='string'?[input[key]]:[]);
 // Glob patterns are paths too: an absolute or parent-relative pattern can leave the workspace.
 if(tool==='Glob' && typeof input.pattern==='string' && (path.isAbsolute(input.pattern) || /(^|\/)\.\.(\/|$)/.test(input.pattern)))targets.push(input.pattern.split(/[*?[{]/)[0] || input.pattern);
 return targets;
}
function inside(root,value){
 if(!root || !value)return false;
 const resolved=path.resolve(root,value);
 return resolved===root || resolved.startsWith(root+path.sep);
}
// Canonical location of a target that may not exist yet: the nearest existing ancestor is resolved
// through symlinks and the remaining components are appended.
async function resolveTarget(root,value){
 const fs=require('node:fs/promises');
 if(!root || !value)return null;
 const candidate=path.resolve(root,value);if(!inside(root,candidate))return null;
 const realRoot=await fs.realpath(root);
 let existing=path.resolve(realRoot,path.relative(path.resolve(root),candidate)),suffix='';
 while(true){
  try{const real=await fs.realpath(existing);return suffix?path.join(real,suffix):real;}
  catch(error){if(error.code!=='ENOENT')return null;const parent=path.dirname(existing);if(parent===existing)return null;suffix=suffix?path.join(path.basename(existing),suffix):path.basename(existing);existing=parent;}
 }
}
async function secureInside(root,value){
 const real=await resolveTarget(root,value);if(!real)return false;
 return inside(await require('node:fs/promises').realpath(root),real);
}
async function isSymlink(root,value){
 try{return (await require('node:fs/promises').lstat(path.resolve(root,value))).isSymbolicLink();}catch{return false;}
}
function decision(tool,input,{mode='full',root}={},resolvedTargets=null){
 const name=String(tool || '');
 const mcp=name.startsWith('mcp__');
 const targets=pathsFromInput(input,name);
 if(targets.some(target=>!inside(root,target)))return {decision:'deny',reason:'This file is outside the selected Claude workspace.'};
 if(mode==='readOnly'){
  if(!mcp && SAFE_READ_TOOLS.has(name))return null;
  return {decision:'deny',reason:'Read-only mode blocks tools that can change files or run commands.'};
 }
 if(mcp)return {decision:'ask',reason:'MCP tools run outside the Just Zen file policy. Review this call explicitly before allowing it.'};
 if(name==='Bash' || name==='Task' || name==='Agent')return {decision:'ask',reason:'This tool can reach beyond Markdown notes. Review it explicitly before allowing it.'};
 // The extension check covers the resolved location as well, so a symlink named note.md cannot stand in for another file.
 const checked=[...targets,...(resolvedTargets || [])];
 if(mode==='notes' && WRITE_TOOLS.has(name) && (!targets.length || checked.some(target=>!MARKDOWN.test(target))))return {decision:'ask',reason:'Notes-only mode requires explicit approval before changing a non-Markdown file.'};
 if(mode==='notes' && !SAFE_READ_TOOLS.has(name) && !WRITE_TOOLS.has(name))return {decision:'ask',reason:'Notes-only mode requires explicit approval for this tool.'};
 return null;
}
function hook(policy){return async input=>{
 const active=policy(),name=String(input.tool_name || ''),resolved=[];
 const deny=reason=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});
 for(const target of pathsFromInput(input.tool_input,name)){
  if(!await secureInside(active.root,target))return deny('This path resolves outside the selected Claude workspace.');
  if(active.mode!=='full' && WRITE_TOOLS.has(name) && await isSymlink(active.root,target))return deny('Just Zen does not change files through symbolic links in Notes-only or Read-only mode.');
  const real=await resolveTarget(active.root,target);if(real)resolved.push(real);
 }
 const result=decision(name,input.tool_input,active,resolved);
 if(!result)return {continue:true};
 return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:result.decision,permissionDecisionReason:result.reason}};
};}
module.exports={decision,hook,inside,secureInside,resolveTarget,pathsFromInput};
