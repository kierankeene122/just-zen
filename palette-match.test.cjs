const test=require('node:test'),assert=require('node:assert/strict');
test('palette ranking prefers exact, prefix and word-start matches over scattered ones',async()=>{
 const {rank,score}=await import('./palette-match.mjs');
 const items=[{label:'Gmail'},{label:'Google Chat'},{label:'Slack'},{label:'Open note: meetings/2026-09-08.md'},{label:'Complete task: mail the invoice'}];
 assert.equal(rank(items,'gm')[0].label,'Gmail');
 assert.equal(rank(items,'chat')[0].label,'Google Chat');
 assert.ok(rank(items,'mail').slice(0,2).map(i=>i.label).includes('Gmail'));
 assert.ok(score('gml','Gmail')>0,'in-order characters still match');
 assert.equal(score('zzz','Gmail'),0);
 assert.equal(rank(items,'').length,5,'empty query keeps everything');
});
