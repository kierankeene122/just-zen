// Formatted text leaving the document editor is reduced to bare allowlisted tags before textutil sees it.
// Everything else is escaped to literal text, so no tag, attribute or script survives however it is spelled.
const ALLOWED='p|br|b|strong|i|em|u|s|ul|ol|li|h[1-6]|table|tbody|tr|td|th|blockquote';
const RESTORE=new RegExp('&lt;(/?)('+ALLOWED+')&gt;','gi');
function sanitizeFormattedHtml(content){
 const bare=String(content).replace(/<\s*(\/?)\s*([a-z0-9]+)\b[^>]*>/gi,'<$1$2>');
 return bare.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(RESTORE,'<$1$2>');
}
module.exports={sanitizeFormattedHtml};
