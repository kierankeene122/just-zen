// The floating search button that sits over a pane's web view. It is its own tiny view because nothing in the page can be drawn on top of a web view.
document.getElementById('b').onclick=()=>window.badge.search();
document.getElementById('x').onclick=()=>window.badge.close();
window.badge.onTheme(theme=>{document.body.dataset.theme=theme;});
window.badge.onLabelled(on=>{document.body.dataset.labelled=String(Boolean(on));});
