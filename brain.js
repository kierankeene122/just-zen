// AI Buster: small local puzzles so your own head stays in the loop. Nothing here talks to the network.
const WORDS='balance breathe candle canvas garden harbour island jungle kettle ladder lantern marble meadow napkin orchard pebble puzzle rhythm saddle timber velvet window yellow anchor bridge butter castle cotton dragon engine feather forest glacier hammer helmet honey jacket kitten lemon magnet mirror needle ocean orange pillow planet pocket rocket saucer shadow silver spider spring summer sunset thunder tunnel turtle valley violin walnut winter wizard basket blanket bubble button cactus camera cherry cloud coffee copper cricket dolphin donkey eagle falcon flower galaxy ginger guitar hazel jigsaw ketchup lettuce library lizard mango market melody monkey muffin noodle oyster panda parrot pencil pepper piano pirate potato pumpkin rabbit ribbon river salmon sandal scarf shovel sketch sponge squirrel stable sugar tablet teapot ticket tomato trumpet tulip umbrella vanilla velvet wallet whistle willow yogurt zebra'.split(/\s+/).filter((w,i,a)=>w.length>=5 && a.indexOf(w)===i);
const rnd=n=>Math.floor(Math.random()*n);
const pick=list=>list[rnd(list.length)];
const shuffle=list=>{const out=[...list];for(let i=out.length-1;i>0;i--){const j=rnd(i+1);[out[i],out[j]]=[out[j],out[i]];}return out;};
const KEY='zen-brain';
function load(){try{return JSON.parse(localStorage.getItem(KEY)) || {};}catch{return {};}}
function save(value){try{localStorage.setItem(KEY,JSON.stringify(value));}catch{}}
const today=()=>new Date().toISOString().slice(0,10);
export function createBrain({menu,play,stats,notice=()=>{}}){
 const $=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
 let timer=null,ticking=null;
 const games=[
  {id:'maths',name:'Quick maths',blurb:'Ten sums against the clock. No calculator, no Claude.',mark:'∑'},
  {id:'words',name:'Word unscramble',blurb:'Put the letters back in order before the hint arrives.',mark:'⌘'},
  {id:'memory',name:'Memory grid',blurb:'Watch the squares light up, then tap them back from memory.',mark:'⊞'},
  {id:'sequence',name:'What comes next',blurb:'Spot the pattern and name the next number.',mark:'→'}
 ];
 function stop(){clearInterval(ticking);clearTimeout(timer);ticking=null;timer=null;}
 function record(game,score,detail){
  const data=load();const day=today();
  if(data.lastDay!==day){data.streak=data.lastDay && (new Date(day)-new Date(data.lastDay))/86400000<=1.5?(data.streak || 0)+1:1;data.lastDay=day;data.today=0;}
  data.today=(data.today || 0)+1;data.total=(data.total || 0)+1;data.best=data.best || {};
  const best=data.best[game];if(best===undefined || score>best.score || (score===best.score && detail.seconds<best.seconds))data.best[game]={score,...detail};
  save(data);renderStats();
 }
 function renderStats(){
  const data=load();stats.replaceChildren();
  const cells=[['Today',String(data.lastDay===today()?data.today || 0:0),'puzzles'],['Streak',String(data.lastDay && (new Date(today())-new Date(data.lastDay))/86400000<=1.5?data.streak || 0:0),'days'],['All time',String(data.total || 0),'puzzles']];
  for(const [label,value,unit] of cells){const c=$('div','brain-stat');c.append($('span',null,label),$('strong',null,value),$('small',null,unit));stats.append(c);}
 }
 function renderMenu(){
  menu.replaceChildren();const data=load();
  for(const game of games){
   const card=$('button','brain-card');card.type='button';
   const best=data.best?.[game.id];
   card.append($('span','brain-mark',game.mark),$('strong',null,game.name),$('p',null,game.blurb),$('small',null,best?'Best: '+best.label:'Not played yet'));
   card.onclick=()=>start(game.id);menu.append(card);
  }
 }
 function frame(title,subtitle){
  stop();play.replaceChildren();play.classList.remove('hidden');menu.classList.add('hidden');
  const head=$('div','brain-head');const back=$('button','secondary','← All puzzles');back.type='button';back.onclick=showMenu;
  const titles=$('div');titles.append($('strong',null,title),$('small',null,subtitle));const clock=$('span','brain-clock','');head.append(back,titles,clock);
  const body=$('div','brain-body');play.append(head,body);return {body,clock};
 }
 function showMenu(){stop();play.classList.add('hidden');play.replaceChildren();menu.classList.remove('hidden');renderMenu();}
 function finish(body,game,score,total,seconds,label){
  stop();body.replaceChildren();
  const done=$('div','brain-done');done.append($('strong',null,score+' / '+total),$('p',null,label),$('small',null,seconds+' seconds'));
  const again=$('button','primary','Play again');again.type='button';again.onclick=()=>start(game);
  const back=$('button','secondary','All puzzles');back.type='button';back.onclick=showMenu;
  const row=$('div','dialog-actions');row.append(back,again);done.append(row);body.append(done);
  record(game,score,{seconds,label:score+'/'+total+' in '+seconds+'s'});
 }
 function startClock(clock,onTick){const started=Date.now();const tick=()=>{const s=Math.round((Date.now()-started)/1000);clock.textContent=s+'s';onTick?.(s);};tick();ticking=setInterval(tick,500);return ()=>Math.round((Date.now()-started)/1000);}
 function askSeries(game,title,subtitle,makeQuestion,total=10){
  const {body,clock}=frame(title,subtitle);let index=0,score=0;const elapsed=startClock(clock);
  const progress=$('div','brain-progress');const question=$('div','brain-question');const answer=$('input');answer.type='text';answer.autocomplete='off';answer.spellcheck=false;answer.className='brain-answer';
  const feedback=$('p','brain-feedback','');const hint=$('p','brain-hint','');
  const form=$('form');form.append(answer);body.append(progress,question,form,feedback,hint);
  let current=null;
  function next(){
   if(index>=total){finish(body,game,score,total,elapsed(),score===total?'Clean sweep.':score>=total*.7?'Sharp.':'Warmed up.');return;}
   current=makeQuestion();question.textContent=current.text;progress.textContent='Question '+(index+1)+' of '+total+' · '+score+' right';answer.value='';hint.textContent='';feedback.textContent='';answer.focus();
   clearTimeout(timer);if(current.hint)timer=setTimeout(()=>{hint.textContent='Hint: '+current.hint;},20000);
  }
  form.onsubmit=e=>{e.preventDefault();const given=answer.value.trim().toLowerCase();if(!given)return;index++;if(current.accept.includes(given)){score++;feedback.textContent='Yes.';}else feedback.textContent='It was '+current.accept[0]+'.';setTimeout(next,650);};
  next();
 }
 function mathsQuestion(){
  const kind=rnd(4);let text,value;
  if(kind===0){const a=rnd(90)+10,b=rnd(90)+10;text=a+' + '+b;value=a+b;}
  else if(kind===1){const a=rnd(90)+20,b=rnd(a-5)+1;text=a+' − '+b;value=a-b;}
  else if(kind===2){const a=rnd(12)+2,b=rnd(12)+2;text=a+' × '+b;value=a*b;}
  else{const a=rnd(9)+2,b=rnd(9)+2,c=rnd(9)+2;text='('+a+' + '+b+') × '+c;value=(a+b)*c;}
  return {text:text+' = ?',accept:[String(value)]};
 }
 function wordQuestion(){
  const word=pick(WORDS);let scrambled=word;for(let i=0;i<10 && scrambled===word;i++)scrambled=shuffle(word.split('')).join('');
  return {text:scrambled.toUpperCase().split('').join(' '),accept:[word],hint:'starts with '+word[0].toUpperCase()+', '+word.length+' letters'};
 }
 function sequenceQuestion(){
  const kind=rnd(5);let seq=[],rule;
  if(kind===0){const start=rnd(20)+1,d=rnd(9)+2;seq=[0,1,2,3,4].map(i=>start+i*d);rule='add '+d;}
  else if(kind===1){const start=rnd(4)+1,m=rnd(2)+2;seq=[0,1,2,3,4].map(i=>start*m**i);rule='multiply by '+m;}
  else if(kind===2){const start=rnd(5)+1;seq=[0,1,2,3,4].map(i=>(start+i)**2);rule='square numbers';}
  else if(kind===3){let a=rnd(5)+1,b=rnd(6)+2;seq=[a,b];while(seq.length<5)seq.push(seq.at(-1)+seq.at(-2));rule='add the two before';}
  else{const start=rnd(30)+10,d=rnd(6)+2;seq=[0,1,2,3,4].map(i=>start+(i%2?d:0)+Math.floor(i/2)*(d*3));rule='alternating steps';}
  let next;
  if(kind===0)next=seq[4]+(seq[1]-seq[0]);else if(kind===1)next=seq[4]*(seq[1]/seq[0]);else if(kind===2)next=(Math.sqrt(seq[4])+1)**2;else if(kind===3)next=seq[4]+seq[3];else next=seq[4]+(seq[4]-seq[3]===0?seq[2]-seq[1]:seq[3]-seq[2]);
  if(kind===4){const d=seq[1]-seq[0];next=seq.length%2===1?seq[4]+d:seq[4]+d*2;}
  return {text:seq.join(', ')+', ?',accept:[String(next)],hint:rule};
 }
 function memoryGame(){
  const {body,clock}=frame('Memory grid','Watch, wait, then tap the squares that lit up.');const elapsed=startClock(clock);
  let round=0,score=0,lit=new Set(),chosen=new Set(),phase='show';const size=5;
  const status=$('p','brain-progress','');const grid=$('div','brain-grid');const cells=[];
  for(let i=0;i<size*size;i++){const cell=$('button','brain-cell');cell.type='button';cell.dataset.index=String(i);cell.onclick=()=>tap(i);cells.push(cell);grid.append(cell);}
  const check=$('button','primary','Check');check.type='button';check.onclick=()=>evaluate();
  body.append(status,grid,check);
  function show(){
   phase='show';chosen.clear();lit=new Set();const count=Math.min(12,4+round);while(lit.size<count)lit.add(rnd(size*size));
   for(const cell of cells){cell.classList.toggle('lit',lit.has(Number(cell.dataset.index)));cell.classList.remove('picked','miss','hit');cell.disabled=true;}
   status.textContent='Round '+(round+1)+' of 5 · remember '+count+' squares';check.disabled=true;
   timer=setTimeout(()=>{phase='recall';for(const cell of cells){cell.classList.remove('lit');cell.disabled=false;}status.textContent='Now tap the '+count+' squares that were lit.';check.disabled=false;},1400+round*250);
  }
  function tap(i){if(phase!=='recall')return;if(chosen.has(i))chosen.delete(i);else chosen.add(i);cells[i].classList.toggle('picked',chosen.has(i));}
  function evaluate(){
   if(phase!=='recall')return;phase='done';let hits=0;
   for(const cell of cells){const i=Number(cell.dataset.index);cell.disabled=true;if(lit.has(i) && chosen.has(i)){hits++;cell.classList.add('hit');}else if(lit.has(i))cell.classList.add('lit');else if(chosen.has(i))cell.classList.add('miss');}
   const perfect=hits===lit.size && chosen.size===lit.size;if(perfect)score++;status.textContent=perfect?'All of them.':hits+' of '+lit.size+' right.';round++;
   timer=setTimeout(()=>{if(round>=5)finish(body,'memory',score,5,elapsed(),score===5?'Photographic.':score>=3?'Good recall.':'Keep looking.');else show();},1300);
  }
  show();
 }
 function start(id){
  if(id==='maths')askSeries('maths','Quick maths','Type the answer and press Enter.',mathsQuestion);
  else if(id==='words')askSeries('words','Word unscramble','Unscramble the word. A hint appears after twenty seconds.',wordQuestion,8);
  else if(id==='sequence')askSeries('sequence','What comes next','Type the next number in the pattern.',sequenceQuestion,8);
  else if(id==='memory')memoryGame();
  notice('Brain break started. Claude can wait.');
 }
 renderStats();renderMenu();
 return {showMenu,stop,reset(){try{localStorage.removeItem(KEY);}catch{}renderStats();renderMenu();}};
}
