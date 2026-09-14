// The floating search button that sits over a pane's web view. It is its own tiny view because nothing in the page can be drawn on top of a web view.
document.getElementById('b').onclick=()=>window.badge.search();
document.getElementById('x').onclick=()=>window.badge.close();
document.getElementById('m').onclick=()=>window.badge.move();
window.badge.onTheme(theme=>{document.body.dataset.theme=theme;});
window.badge.onLabelled(on=>{document.body.dataset.labelled=String(Boolean(on));});

// Drag the grip: the view itself moves under the pointer (the main process moves it), so screen deltas are what matter.
(()=>{const g=document.getElementById('g');let last=null;
 g.addEventListener('mousedown',e=>{e.preventDefault();last={x:e.screenX,y:e.screenY};});
 window.addEventListener('mousemove',e=>{if(!last)return;const dx=e.screenX-last.x,dy=e.screenY-last.y;if(!dx && !dy)return;last={x:e.screenX,y:e.screenY};window.badge.drag({dx,dy});});
 window.addEventListener('mouseup',()=>{if(!last)return;last=null;window.badge.drag({dx:0,dy:0,done:true});});
 window.addEventListener('mouseleave',()=>{if(!last)return;last=null;window.badge.drag({dx:0,dy:0,done:true});});})();
