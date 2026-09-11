function secureOrigin(value){
 try{const url=new URL(value);return url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','::1'].includes(url.hostname));}catch{return false;}
}

// A saved app may notify only from the origins it was saved at or landed on during its first load.
// Pages reached later, for example through an open redirect, do not gain the permission.
function canNotify(source,contents,requestingOrigin=''){
 if(!source || source.contents!==contents || !source.saved || !(source.origins instanceof Set))return false;
 const current=contents?.getURL?.() || '';
 if(!secureOrigin(current) || (requestingOrigin && !secureOrigin(requestingOrigin)))return false;
 try{return source.origins.has(new URL(requestingOrigin || current).origin);}catch{return false;}
}

function unreadCount(title=''){
 const text=String(title).trim();
 const match=text.match(/(?:\(([\d,]{1,7})\)|\[([\d,]{1,7})\])/)
  || text.match(/\b([\d,]{1,7})\s+(?:unread|new messages?|new notifications?)\b/i);
 if(match)return Math.min(9999,Number((match[1] || match[2]).replace(/,/g,'')) || 0);
 // Slack and others mark unread with a leading dot or asterisk and no number.
 return /^[•*●]\s/.test(text)?1:0;
}

module.exports={canNotify,unreadCount,secureOrigin};
