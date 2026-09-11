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
