// Runs in every website view, isolated from the page: nothing is exposed to page scripts.
// It only (1) offers to fill a saved login when the user focuses a login field and (2) reports a submitted login so the app can offer to save it.
const {ipcRenderer}=require('electron');
const passwordField=el=>el && el.tagName==='INPUT' && el.type==='password';
const usernameFor=pw=>{const form=pw.form || pw.closest('form') || document;const inputs=[...form.querySelectorAll('input')].filter(i=>!i.disabled && i.type!=='hidden' && i.offsetParent!==null);const idx=inputs.indexOf(pw);const before=inputs.slice(0,idx).reverse().find(i=>['text','email','tel',''].includes(i.type) || i.autocomplete==='username');return before || inputs.find(i=>['text','email'].includes(i.type)) || null;};
let lastSent='';
function report(pw){if(!passwordField(pw) || !pw.value)return;const user=usernameFor(pw);const payload={username:user?String(user.value).slice(0,300):'',password:String(pw.value).slice(0,1000)};const sig=payload.username+'\0'+payload.password;if(sig===lastSent)return;lastSent=sig;ipcRenderer.send('web-password-submitted',payload);}
document.addEventListener('submit',e=>{const pw=e.target?.querySelector?.('input[type=password]');if(pw)report(pw);},true);
document.addEventListener('keydown',e=>{if(e.key==='Enter' && passwordField(document.activeElement))report(document.activeElement);},true);
document.addEventListener('click',e=>{const b=e.target?.closest?.('button,input[type=submit]');if(!b)return;const form=b.form || b.closest('form');const pw=form?.querySelector('input[type=password]') || (document.activeElement && passwordField(document.activeElement)?document.activeElement:null);if(pw)report(pw);},true);
let filledFor=null;
async function offerFill(target){
 const form=target.form || target.closest('form') || document;const pw=passwordField(target)?target:form.querySelector('input[type=password]');if(!pw || pw.value)return;
 if(filledFor===pw)return;filledFor=pw;
 const saved=await ipcRenderer.invoke('web-password-request').catch(()=>null);if(!saved)return;
 const setValue=(el,value)=>{if(!el)return;const proto=Object.getPrototypeOf(el);const desc=Object.getOwnPropertyDescriptor(proto,'value');desc?.set?.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
 const user=usernameFor(pw);if(user && !user.value && saved.username)setValue(user,saved.username);setValue(pw,saved.password);
}
document.addEventListener('focusin',e=>{const el=e.target;if(!el || el.tagName!=='INPUT')return;if(passwordField(el) || (['text','email','tel',''].includes(el.type) && (el.form || el.closest('form'))?.querySelector('input[type=password]')))offerFill(el);},true);

// Unread counts for sites that keep them in the page rather than the title. Read from the isolated world, sent only from the top frame.
const UNREAD_PROBES={
 'chat.google.com':()=>{let n=0;for(const el of document.querySelectorAll('div[data-section-type] div.TeR7uc'))n+=Number(String(el.textContent).replace(/\D/g,''))||0;if(!n)for(const el of document.querySelectorAll('[role="listitem"][aria-label]')){const m=String(el.getAttribute('aria-label')).match(/\b([1-9]\d*)\s+unread\b/i);if(m)n+=Number(m[1]);}return n;},
 'mail.google.com':()=>{const m=document.title.match(/\((\d+)\)/);return m?Number(m[1]):0;},
 'app.slack.com':()=>{let n=0;for(const el of document.querySelectorAll('.p-channel_sidebar__badge'))n+=Number(String(el.textContent).replace(/\D/g,''))||0;if(!n)n=document.querySelectorAll('.p-channel_sidebar__channel--unread:not(.p-channel_sidebar__channel--muted),.p-channel_sidebar__link--unread').length;return n;},
 'teams.microsoft.com':()=>{let n=0;for(const el of document.querySelectorAll('[aria-label]')){const m=String(el.getAttribute('aria-label')).match(/\b([1-9]\d*)\s+unread\b/i);if(m)n+=Number(m[1]);}return n;},
 'web.whatsapp.com':()=>{let n=0;for(const el of document.querySelectorAll('[aria-label$="unread message"],[aria-label$="unread messages"]'))n+=Number(String(el.getAttribute('aria-label')).replace(/\D/g,''))||0;return n;},
 'discord.com':()=>{let n=0;for(const el of document.querySelectorAll('[class*="numberBadge"]'))n+=Number(String(el.textContent).replace(/\D/g,''))||0;return n;}
};
if(window===window.top){const probe=Object.entries(UNREAD_PROBES).find(([host])=>location.hostname===host || location.hostname.endsWith('.'+host))?.[1];if(probe){let last=-1;setInterval(()=>{let n=0;try{n=probe();}catch{}if(n!==last){last=n;ipcRenderer.send('web-unread',n);}},4000);}}

// Sites like Slack replace the right-click menu with their own, which also hides Just Zen's. When text is selected the
// app's menu takes over (Send to Claude, Send to Tasks, Copy); with nothing selected the site's own menu is left alone.
window.addEventListener('contextmenu',e=>{const text=String(window.getSelection?.() || '').trim();const t=e.target;const link=String(t?.closest?.('a[href]')?.href || '');if(!text && !/^https?:/i.test(link))return;e.preventDefault();e.stopImmediatePropagation();const editable=Boolean(t && (t.isContentEditable || ['INPUT','TEXTAREA'].includes(t.tagName)));ipcRenderer.send('web-context-selection',{text:text.slice(0,20000),link:link.slice(0,2000),editable});},true);

// Shift+Space peeks at the link under the pointer without leaving the page.
let hoveredLink='';
document.addEventListener('mouseover',e=>{const a=e.target?.closest?.('a[href]');hoveredLink=a?String(a.href):'';},true);
document.addEventListener('keydown',e=>{if(e.key===' ' && e.shiftKey && hoveredLink && /^https?:/i.test(hoveredLink) && !(document.activeElement && (document.activeElement.isContentEditable || ['INPUT','TEXTAREA'].includes(document.activeElement.tagName)))){e.preventDefault();e.stopImmediatePropagation();ipcRenderer.send('web-peek-link',hoveredLink);}},true);

// Delivering text into an app's composer. Recipes per site; the generic fallback uses the focused editor or the first one.
// Text is inserted only; nothing is ever submitted.
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const visible=el=>el && el.offsetParent!==null && !el.disabled;
const editors=()=>[...document.querySelectorAll('[contenteditable="true"],[contenteditable=""],textarea')].filter(visible);
async function composerFor(mode){
 const host=location.hostname;
 if(host.endsWith('mail.google.com')){
  let body=editors().find(e=>/message body/i.test(e.getAttribute('aria-label') || ''));
  if(!body){const button=mode==='reply'?[...document.querySelectorAll('[role="button"],[aria-label]')].find(e=>/^reply$/i.test(e.getAttribute('aria-label') || e.textContent.trim())):document.querySelector('[gh="cm"],[role="button"][aria-label*="Compose" i]');button?.click();for(let i=0;i<20 && !body;i++){await sleep(150);body=editors().find(e=>/message body/i.test(e.getAttribute('aria-label') || ''));}}
  return body || null;
 }
 if(host.endsWith('slack.com'))return editors().find(e=>e.classList.contains('ql-editor') || /message/i.test(e.getAttribute('aria-label') || '')) || null;
 if(host.endsWith('chat.google.com') || host.endsWith('teams.microsoft.com') || host.endsWith('web.whatsapp.com') || host.endsWith('discord.com'))return editors().find(e=>/message|type|reply|say something/i.test(e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.dataset.placeholder || '')) || editors().at(-1) || null;
 const active=document.activeElement;if(active && visible(active) && (active.isContentEditable || active.tagName==='TEXTAREA'))return active;
 return editors()[0] || null;
}
async function deliver(text,mode){
 const target=await composerFor(mode);if(!target)return {ok:false,reason:'No message box is open here. Open a reply or a new message first.'};
 target.focus();
 if(target.tagName==='TEXTAREA'){const proto=Object.getPrototypeOf(target);const desc=Object.getOwnPropertyDescriptor(proto,'value');const start=target.selectionStart ?? target.value.length;const next=target.value.slice(0,start)+text+target.value.slice(target.selectionEnd ?? start);desc?.set?.call(target,next);target.dispatchEvent(new Event('input',{bubbles:true}));return {ok:true};}
 const ok=document.execCommand('insertText',false,text);if(!ok){target.textContent+=text;target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));}
 return {ok:true};
}
ipcRenderer.on('web-deliver',async (_e,{id,text,mode})=>{let result;try{result=await deliver(String(text || ''),mode);}catch(error){result={ok:false,reason:String(error.message || error)};}ipcRenderer.send('web-deliver-result',{id,...result});});
// Items for the Now stream: what is unread, by name, so nothing has to be opened just to look.
const ITEM_PROBES={
 'mail.google.com':()=>[...document.querySelectorAll('tr.zA.zE')].slice(0,6).map(row=>{const id=row.getAttribute('data-legacy-thread-id') || row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id') || '';return {title:row.querySelector('.bog')?.textContent.trim() || row.querySelector('[data-thread-id] span')?.textContent.trim() || '',sub:row.querySelector('.yX .yP,.yX .zF')?.textContent.trim() || '',url:id?'https://mail.google.com/mail/u/0/#inbox/'+id:''};}).filter(i=>i.title),
 'app.slack.com':()=>[...document.querySelectorAll('.p-channel_sidebar__channel--unread:not(.p-channel_sidebar__channel--muted),.p-channel_sidebar__link--unread')].slice(0,8).map(a=>({title:(a.querySelector('.p-channel_sidebar__name')?.textContent || a.textContent).trim(),sub:a.querySelector('.p-channel_sidebar__badge')?.textContent.trim() || 'unread',url:a.href || ''})).filter(i=>i.title),
 'chat.google.com':()=>[...document.querySelectorAll('[role="listitem"][aria-label]')].filter(el=>/\b[1-9]\d*\s+unread\b/i.test(el.getAttribute('aria-label') || '')).slice(0,8).map(el=>({title:String(el.getAttribute('aria-label')).replace(/,?\s*\d+ unread.*$/i,'').trim().slice(0,80),sub:'unread',url:''})).filter(i=>i.title),
 'teams.microsoft.com':()=>[...document.querySelectorAll('[aria-label]')].filter(el=>/\b[1-9]\d*\s+unread\b/i.test(el.getAttribute('aria-label') || '')).slice(0,8).map(el=>({title:String(el.getAttribute('aria-label')).replace(/,?\s*\d+ unread.*$/i,'').trim().slice(0,80),sub:'unread',url:''})).filter(i=>i.title)
};
if(window===window.top){const probe=Object.entries(ITEM_PROBES).find(([host])=>location.hostname===host || location.hostname.endsWith('.'+host))?.[1];if(probe){let last='';setInterval(()=>{let items=[];try{items=probe();}catch{}const sig=JSON.stringify(items);if(sig!==last){last=sig;ipcRenderer.send('web-items',items.slice(0,8));}},8000);}}
