const test=require('node:test'),assert=require('node:assert/strict');
const {supportWindow}=require('./scripts/electron-support.cjs');
const releases=[{version:'44.0.0',date:'2026-08-24'},{version:'44.1.0',date:'2026-09-15'},{version:'45.0.0-beta.1',date:'2026-09-01'},{version:'45.0.0',date:'2026-10-20'},{version:'46.0.0',date:'2026-12-15'},{version:'47.0.0',date:'2027-02-09'}];
test('support ends when the third following major ships',()=>{
 const w=supportWindow('44.2.0',releases,new Date('2026-09-09'));
 assert.equal(w.supportEnds,'2027-02-09');assert.equal(w.estimated,false);assert.equal(w.daysLeft,153);
});
test('without a known successor the end date is estimated from the release cadence',()=>{
 const w=supportWindow('46.0.1',releases,new Date('2026-12-16'));
 assert.equal(w.estimated,true);assert.equal(w.supportEnds,'2027-05-31');
});
