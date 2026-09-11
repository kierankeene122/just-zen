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
 'chat.google.com':()=>{let n=0;for(const el of document.querySelectorAll('div[data-section-type] div.TeR7uc'))n+=Number(String(el.textContent).replace(/\D/g,''))||0;if(!n)n=document.querySelectorAll('[data-unread="true"],[aria-label*="unread" i]').length;return n;},
 'mail.google.com':()=>{const m=document.title.match(/\((\d+)\)/);return m?Number(m[1]):0;},
 'app.slack.com':()=>{let n=0;for(const el of document.querySelectorAll('.p-channel_sidebar__badge'))n+=Number(String(el.textContent).replace(/\D/g,''))||0;if(!n)n=document.querySelectorAll('.p-channel_sidebar__channel--unread:not(.p-channel_sidebar__channel--muted),.p-channel_sidebar__link--unread').length;return n;},
 'teams.microsoft.com':()=>{let n=0;for(const el of document.querySelectorAll('[data-tid*="badge" i],[class*="badge" i]'))n+=Number(String(el.textContent).replace(/\D/g,''))||0;return n;},
 'web.whatsapp.com':()=>{let n=0;for(const el of document.querySelectorAll('[aria-label$="unread message"],[aria-label$="unread messages"]'))n+=Number(String(el.getAttribute('aria-label')).replace(/\D/g,''))||0;return n;},
 'discord.com':()=>{let n=0;for(const el of document.querySelectorAll('[class*="numberBadge"]'))n+=Number(String(el.textContent).replace(/\D/g,''))||0;return n;}
};
if(window===window.top){const probe=Object.entries(UNREAD_PROBES).find(([host])=>location.hostname===host || location.hostname.endsWith('.'+host))?.[1];if(probe){let last=-1;setInterval(()=>{let n=0;try{n=probe();}catch{}if(n!==last){last=n;ipcRenderer.send('web-unread',n);}},4000);}}

// Sites like Slack replace the right-click menu with their own, which also hides Just Zen's. When text is selected the
// app's menu takes over (Send to Claude, Send to Tasks, Copy); with nothing selected the site's own menu is left alone.
window.addEventListener('contextmenu',e=>{const text=String(window.getSelection?.() || '').trim();if(!text)return;e.preventDefault();e.stopImmediatePropagation();const t=e.target;const editable=Boolean(t && (t.isContentEditable || ['INPUT','TEXTAREA'].includes(t.tagName)));ipcRenderer.send('web-context-selection',{text:text.slice(0,20000),link:String(t?.closest?.('a')?.href || '').slice(0,2000),editable});},true);
