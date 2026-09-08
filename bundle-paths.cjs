// Files that another process must open directly (a Node child, sandbox-exec) cannot live inside app.asar.
// They are unpacked beside it at build time; this maps the in-archive path to the unpacked copy.
function externalPath(value){return String(value).replace(/\.asar(?=[\\/])/,'.asar.unpacked');}
module.exports={externalPath};
