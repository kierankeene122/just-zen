const test=require('node:test'),assert=require('node:assert/strict');
const {seedPins}=require('./panel-seed.cjs');

test('web apps configured before become the first pins, once',()=>{
  const services=[{id:'b',kind:'browser',name:'Browser'},{name:'Gmail',url:'https://mail.google.com/'},{name:'Slack',url:'https://slack.com/'}];
  const first=seedPins({pins:[],services,seeded:false});
  assert.equal(first.changed,true);
  assert.deepEqual(first.pins.map(p=>p.label),['Gmail','Slack']);
  assert.deepEqual(first.pins.map(p=>p.kind),['web','web']);
  assert.equal(first.pins[0].id,'web:https://mail.google.com/');
  assert.equal(first.seeded,true);

  const again=seedPins({pins:[],services,seeded:true});
  assert.equal(again.changed,false,'it only happens once');
});

test('an empty first run does not count as having seeded',()=>{
  const nothing=seedPins({pins:[],services:[{id:'b',kind:'browser',name:'Browser'}],seeded:false});
  assert.equal(nothing.changed,false);
  assert.equal(nothing.seeded,false,'so a later run with real apps still carries them over');
});

test('a panel someone has already arranged is left alone',()=>{
  const mine=[{id:'web:https://example.com/',kind:'web',label:'Example'}];
  const result=seedPins({pins:mine,services:[{name:'Gmail',url:'https://mail.google.com/'}],seeded:false});
  assert.equal(result.changed,false);
  assert.deepEqual(result.pins,mine);
});

test('only real web addresses are carried over',()=>{
  const result=seedPins({pins:[],services:[{name:'Odd',url:'javascript:alert(1)'},{name:'Fine',url:'https://fine.example/'}],seeded:false});
  assert.deepEqual(result.pins.map(p=>p.label),['Fine']);
});
