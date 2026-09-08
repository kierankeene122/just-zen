// Ranking for the command palette: prefix and word-start matches first, then in-order character matches.
export function score(query,text){
 const q=String(query).toLowerCase().trim(),t=String(text).toLowerCase();
 if(!q)return 1;
 if(t===q)return 100;
 if(t.startsWith(q))return 90;
 const wordStart=t.split(/[\s/._-]+/).some(w=>w.startsWith(q));if(wordStart)return 80;
 const at=t.indexOf(q);if(at>=0)return 70-Math.min(20,at/4);
 let i=0;for(const c of t){if(c===q[i])i++;if(i===q.length)break;}
 return i===q.length?40-Math.min(20,t.length/10):0;
}
export function rank(items,query,limit=8){
 return items.map(item=>({item,score:score(query,item.label)+(item.hint?score(query,item.hint)/4:0)}))
  .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.item);
}
