const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {findClaude}=require('./claude-runtime.cjs');
test('the Claude CLI bundled with the Agent SDK is preferred over system installs',()=>{
 const found=findClaude({candidates:['/nonexistent/claude']});
 assert.ok(found.endsWith(path.join('claude-agent-sdk-darwin-arm64','claude')),found);
});
test('a system install is only a fallback',()=>{
 const found=findClaude({packageRoot:'/nonexistent',candidates:['/opt/homebrew/bin/claude','/usr/local/bin/claude']});
 assert.ok(found.endsWith('/bin/claude'));
});
