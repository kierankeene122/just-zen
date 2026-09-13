// A small PowerPoint reader: a .pptx is a zip of XML, and this turns it into a plain deck description
// (slides, text boxes, pictures, fills, positions in EMU) that the document pane can draw. No native
// dependencies, so it runs the same inside the sandboxed document worker on macOS and Windows.
const zlib=require('node:zlib');

// ---- zip: just enough of the format for Office files (deflate or stored, no ZIP64, no encryption)
function readZip(buffer){
 const entries=new Map();
 let eocd=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-70000);i--){if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
 if(eocd<0)throw Error('Not a PowerPoint file');
 const count=buffer.readUInt16LE(eocd+10);let at=buffer.readUInt32LE(eocd+16);
 for(let n=0;n<count;n++){
  if(buffer.readUInt32LE(at)!==0x02014b50)break;
  const method=buffer.readUInt16LE(at+10),csize=buffer.readUInt32LE(at+20),usize=buffer.readUInt32LE(at+24),nameLen=buffer.readUInt16LE(at+28),extraLen=buffer.readUInt16LE(at+30),commentLen=buffer.readUInt16LE(at+32),local=buffer.readUInt32LE(at+42);
  const name=buffer.toString('utf8',at+46,at+46+nameLen);
  entries.set(name,{method,csize,usize,local});
  at+=46+nameLen+extraLen+commentLen;
 }
 const raw=name=>{const e=entries.get(name);if(!e)return null;const h=e.local;const start=h+30+buffer.readUInt16LE(h+26)+buffer.readUInt16LE(h+28);return {method:e.method,crc:buffer.readUInt32LE(e.local+14),csize:e.csize,usize:e.usize,data:buffer.subarray(start,start+e.csize)};};
 const read=name=>{const e=entries.get(name);if(!e)return null;if(e.usize>64*1024*1024)throw Error('Presentation part too large');const h=e.local;if(buffer.readUInt32LE(h)!==0x04034b50)return null;const start=h+30+buffer.readUInt16LE(h+26)+buffer.readUInt16LE(h+28);const raw=buffer.subarray(start,start+e.csize);if(e.method===0)return raw;if(e.method===8)return zlib.inflateRawSync(raw);throw Error('Unsupported compression in presentation');};
 return {has:name=>entries.has(name),read,raw,text:name=>{const b=read(name);return b?b.toString('utf8'):null;},names:()=>[...entries.keys()]};
}

// ---- xml: a tolerant tokenizer that builds a tree; Office XML is well formed and free of CDATA
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
function decode(text){return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>{if(e[0]==='#')return String.fromCodePoint(e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):parseInt(e.slice(1),10));return ENTITIES[e] ?? m;});}
function parseXml(text){
 const root={name:'#root',attrs:{},children:[]};const stack=[root];const re=/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;let m;
 while((m=re.exec(text))){
  if(m[1]){if(stack.length>1)stack.pop();continue;}
  if(m[2]){const attrs={};const ar=/([\w:.-]+)\s*=\s*"([^"]*)"/g;let a;while((a=ar.exec(m[3])))attrs[a[1]]=decode(a[2]);const node={name:m[2],attrs,children:[]};stack[stack.length-1].children.push(node);if(!m[4])stack.push(node);continue;}
  if(m[5]!==undefined){const t=m[5];if(t.trim())stack[stack.length-1].children.push({name:'#text',text:decode(t)});}
 }
 return root;
}
const kids=(n,name)=>n?n.children.filter(c=>c.name===name):[];
const kid=(n,name)=>n?n.children.find(c=>c.name===name) || null:null;
function find(n,name){if(!n)return null;for(const c of n.children){if(c.name===name)return c;if(c.children){const r=find(c,name);if(r)return r;}}return null;}
function findAll(n,name,out=[]){if(!n)return out;for(const c of n.children){if(c.name===name)out.push(c);if(c.children)findAll(c,name,out);}return out;}
const textOf=n=>n?n.children.map(c=>c.name==='#text'?c.text:textOf(c)).join(''):'';

function rels(zip,partPath){
 const dir=partPath.slice(0,partPath.lastIndexOf('/')),file=partPath.slice(partPath.lastIndexOf('/')+1);
 const xml=zip.text(dir+'/_rels/'+file+'.rels');const map=new Map();if(!xml)return map;
 for(const r of findAll(parseXml(xml),'Relationship')){const target=r.attrs.Target || '';map.set(r.attrs.Id,{type:r.attrs.Type || '',path:resolvePath(dir,target)});}
 return map;
}
function resolvePath(dir,target){if(target.startsWith('/'))return target.slice(1);const parts=(dir+'/'+target).split('/');const out=[];for(const p of parts){if(p==='..')out.pop();else if(p!=='.' && p!=='')out.push(p);}return out.join('/');}
const relOfType=(map,suffix)=>[...map.values()].find(r=>r.type.endsWith(suffix)) || null;

// ---- colours
const SCHEME_ALIAS={tx1:'dk1',bg1:'lt1',tx2:'dk2',bg2:'lt2'};
function themeColours(zip,themePath){const out={};const xml=themePath?zip.text(themePath):null;if(!xml)return out;const scheme=find(parseXml(xml),'a:clrScheme');if(!scheme)return out;for(const c of scheme.children){if(!c.name || c.name==='#text')continue;const key=c.name.replace('a:','');const srgb=find(c,'a:srgbClr'),sys=find(c,'a:sysClr');out[key]=srgb?srgb.attrs.val:(sys?(sys.attrs.lastClr || (sys.attrs.val==='windowText'?'000000':'FFFFFF')):null);}return out;}
function colourOf(node,theme){if(!node)return null;const srgb=kid(node,'a:srgbClr');if(srgb){return applyMods('#'+srgb.attrs.val,srgb);}const sch=kid(node,'a:schemeClr');if(sch){const key=SCHEME_ALIAS[sch.attrs.val] || sch.attrs.val;const hex=theme[key];return hex?applyMods('#'+hex,sch):null;}const prst=kid(node,'a:prstClr');if(prst)return prst.attrs.val;const sys=kid(node,'a:sysClr');if(sys)return '#'+(sys.attrs.lastClr || '000000');return null;}
function applyMods(hex,node){const lum=kid(node,'a:lumMod'),off=kid(node,'a:lumOff'),alpha=kid(node,'a:alpha');if(!lum && !off && !alpha)return hex;let [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);let l=(Math.max(r,g,b)+Math.min(r,g,b))/2;const mod=lum?Number(lum.attrs.val)/100000:1,add=off?Number(off.attrs.val)/100000:0;const target=Math.max(0,Math.min(1,l*mod+add));const k=l>0?target/l:0;if(l>0 && target>l){const t=(target-l)/(1-l);[r,g,b]=[r,g,b].map(v=>v+(1-v)*t);}else{[r,g,b]=[r,g,b].map(v=>v*k);}const a=alpha?Number(alpha.attrs.val)/100000:1;const c=[r,g,b].map(v=>Math.round(Math.max(0,Math.min(1,v))*255));return a<1?`rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(2)})`:'#'+c.map(v=>v.toString(16).padStart(2,'0')).join('');}
function fillOf(node,theme){if(!node)return null;const solid=kid(node,'a:solidFill');if(solid)return colourOf(solid,theme);const grad=kid(node,'a:gradFill');if(grad){const stops=findAll(grad,'a:gs').map(s=>colourOf(s,theme)).filter(Boolean);if(stops.length>1)return `linear-gradient(160deg, ${stops[0]}, ${stops[stops.length-1]})`;if(stops.length)return stops[0];}if(kid(node,'a:noFill'))return 'transparent';return null;}

// ---- geometry
function xfrmOf(node){const x=kid(kid(node,'p:spPr') || kid(node,'p:grpSpPr') || node,'a:xfrm');if(!x)return null;const off=kid(x,'a:off'),ext=kid(x,'a:ext');if(!off || !ext)return null;const box={x:Number(off.attrs.x),y:Number(off.attrs.y),w:Number(ext.attrs.cx),h:Number(ext.attrs.cy),rot:Number(x.attrs.rot || 0)/60000,flipH:x.attrs.flipH==='1',flipV:x.attrs.flipV==='1'};const chOff=kid(x,'a:chOff'),chExt=kid(x,'a:chExt');if(chOff && chExt)box.child={x:Number(chOff.attrs.x),y:Number(chOff.attrs.y),w:Number(chExt.attrs.cx),h:Number(chExt.attrs.cy)};return box;}
function phOf(node){const ph=find(kid(node,'p:nvSpPr') || kid(node,'p:nvPicPr') || node,'p:ph');return ph?{type:ph.attrs.type || 'body',idx:ph.attrs.idx || ''}:null;}
function placeholderTable(tree){const table=[];for(const sp of findAll(find(tree,'p:spTree') || tree,'p:sp')){const ph=phOf(sp);if(!ph)continue;table.push({ph,box:xfrmOf(sp),body:kid(sp,'p:txBody'),spPr:kid(sp,'p:spPr')});}return table;}
function lookupPlaceholder(tables,ph){if(!ph)return null;const same=(a,b)=>{const ta=a.type==='ctrTitle'?'title':a.type,tb=b.type==='ctrTitle'?'title':b.type;return ta===tb;};for(const table of tables){let hit=ph.idx?table.find(e=>e.ph.idx===ph.idx && same(e.ph,ph)):null;if(!hit)hit=table.find(e=>same(e.ph,ph) && (!ph.idx || !e.ph.idx || e.ph.idx===ph.idx));if(!hit && ph.idx)hit=table.find(e=>e.ph.idx===ph.idx);if(hit && hit.box)return hit;}return null;}

// ---- text
function paragraphsOf(body,theme,defaults){if(!body)return [];const out=[];const bodyPr=kid(body,'a:bodyPr');const anchor=bodyPr?.attrs.anchor || 't';
 for(const p of kids(body,'a:p')){const pPr=kid(p,'a:pPr');const lvl=Number(pPr?.attrs.lvl || 0);const algn=pPr?.attrs.algn || defaults.align || 'l';const bullet=pPr?(kid(pPr,'a:buNone')?false:(kid(pPr,'a:buChar') || kid(pPr,'a:buAutoNum')?true:(defaults.bullets && lvl>=0))):Boolean(defaults.bullets);const runs=[];
  for(const c of p.children){if(c.name==='a:r' || c.name==='a:fld'){const rPr=kid(c,'a:rPr');const t=textOf(kid(c,'a:t'));if(!t && c.name==='a:r')continue;runs.push({text:c.name==='a:fld' && !t?(c.attrs.type==='slidenum'?'#':''):t,size:rPr?.attrs.sz?Number(rPr.attrs.sz)/100:null,bold:rPr?.attrs.b==='1',italic:rPr?.attrs.i==='1',underline:Boolean(rPr?.attrs.u && rPr.attrs.u!=='none'),strike:Boolean(rPr?.attrs.strike && rPr.attrs.strike!=='noStrike'),color:colourOf(kid(rPr,'a:solidFill'),theme),font:kid(rPr,'a:latin')?.attrs.typeface || null});}
   else if(c.name==='a:br')runs.push({text:'\n',size:null});}
  const endPr=kid(p,'a:endParaRPr');out.push({runs,lvl,align:algn,bullet:bullet && runs.some(r=>r.text.trim()),size:endPr?.attrs.sz?Number(endPr.attrs.sz)/100:null,anchor});}
 return out;}

function parsePptx(buffer){
 const zip=readZip(buffer);
 const presXml=zip.text('ppt/presentation.xml');if(!presXml)throw Error('Not a PowerPoint file');
 const pres=parseXml(presXml);const size=find(pres,'p:sldSz');const width=Number(size?.attrs.cx || 12192000),height=Number(size?.attrs.cy || 6858000);
 const presRels=rels(zip,'ppt/presentation.xml');
 const slidePaths=findAll(pres,'p:sldId').map(s=>presRels.get(s.attrs['r:id'])?.path).filter(Boolean).slice(0,300);
 const cache=new Map();const load=path=>{if(!cache.has(path)){const t=zip.text(path);cache.set(path,t?parseXml(t):null);}return cache.get(path);};
 const slides=[];let images=0;
 for(const slidePath of slidePaths){
  const tree=load(slidePath);if(!tree)continue;const slideRels=rels(zip,slidePath);
  const layoutPath=relOfType(slideRels,'/slideLayout')?.path;const layout=layoutPath?load(layoutPath):null;const layoutRels=layoutPath?rels(zip,layoutPath):new Map();
  const masterPath=relOfType(layoutRels,'/slideMaster')?.path;const master=masterPath?load(masterPath):null;const masterRels=masterPath?rels(zip,masterPath):new Map();
  const theme=themeColours(zip,relOfType(masterRels,'/theme')?.path);
  const tables=[layout?placeholderTable(layout):[],master?placeholderTable(master):[]];
  const bgOf=t=>{const bg=find(kid(find(t,'p:cSld') || t,'p:bg') || null,'p:bgPr');return bg?fillOf(bg,theme):null;};
  const background=bgOf(tree) || bgOf(layout) || bgOf(master) || '#ffffff';
  const shapes=[];const order=findAll(find(tree,'p:spTree') || tree,'p:sp');
  const walk=(container,transform)=>{
   for(const node of container.children){
    if(node.name==='p:grpSp'){const box=xfrmOf(node);const next=box && box.child?compose(transform,box):transform;walk(node,next);continue;}
    if(node.name==='p:sp' || node.name==='p:pic'){
     const ph=phOf(node);let box=xfrmOf(node);let inherited=null;if(!box && ph){inherited=lookupPlaceholder(tables,ph);box=inherited?.box || null;}
     if(!box)continue;const placed=applyTransform(transform,box);
     const spPr=kid(node,'p:spPr');const geom=kid(spPr,'a:prstGeom')?.attrs.prst || 'rect';
     if(node.name==='p:pic'){const blip=find(node,'a:blip');const target=blip?slideRels.get(blip.attrs['r:embed'])?.path:null;const data=target && images<60?zip.read(target):null;if(!data || data.length>8*1024*1024)continue;images++;const ext=target.slice(target.lastIndexOf('.')+1).toLowerCase();const mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',webp:'image/webp',bmp:'image/bmp',tif:'image/tiff',tiff:'image/tiff'}[ext];if(!mime)continue;shapes.push({kind:'image',...placed,src:'data:'+mime+';base64,'+data.toString('base64'),geom});continue;}
     const fill=fillOf(spPr,theme) ?? (ph?null:fillOf(kid(node,'p:style') && kid(kid(node,'p:style'),'a:fillRef'),theme));
     const line=kid(spPr,'a:ln');const lineColour=line && !kid(line,'a:noFill')?colourOf(kid(line,'a:solidFill'),theme):null;
     const isTitle=ph && (ph.type==='title' || ph.type==='ctrTitle');const isBody=ph && ['body','obj','subTitle'].includes(ph.type);
     const defaults={align:isTitle || ph?.type==='subTitle'?(ph.type==='ctrTitle' || ph.type==='subTitle'?'ctr':'l'):'l',bullets:Boolean(ph && ph.type==='body' || ph?.type==='obj'),size:isTitle?40:isBody?20:18};
     const paragraphs=paragraphsOf(kid(node,'p:txBody'),theme,defaults);
     const bodyPr=kid(kid(node,'p:txBody'),'a:bodyPr') || (inherited?kid(inherited.body,'a:bodyPr'):null);
     shapes.push({kind:'shape',ref:{slide:slidePath,index:order.indexOf(node)},...placed,geom,fill,lineColour,paragraphs,anchor:bodyPr?.attrs.anchor || (isTitle?'ctr':'t'),defaultSize:defaults.size,placeholder:ph?ph.type:null,inset:{l:Number(bodyPr?.attrs.lIns ?? 91440),t:Number(bodyPr?.attrs.tIns ?? 45720),r:Number(bodyPr?.attrs.rIns ?? 91440),b:Number(bodyPr?.attrs.bIns ?? 45720)},wrap:bodyPr?.attrs.wrap!=='none'});
    }
   }
  };
  walk(find(tree,'p:spTree') || tree,null);
  const notesPath=relOfType(slideRels,'/notesSlide')?.path;const notesTree=notesPath?load(notesPath):null;const notes=notesTree?findAll(notesTree,'p:sp').filter(sp=>phOf(sp)?.type==='body').map(sp=>paragraphsOf(kid(sp,'p:txBody'),theme,{}).map(p=>p.runs.map(r=>r.text).join('')).join('\n')).join('\n').trim():'';
  slides.push({background,shapes,notes});
 }
 return {width,height,slides};
}
function compose(outer,group){const local={x:group.x,y:group.y,w:group.w,h:group.h,child:group.child};if(!outer)return local;const placed=applyTransform(outer,group);return {x:placed.x,y:placed.y,w:placed.w,h:placed.h,child:group.child};}
function applyTransform(t,box){if(!t || !t.child)return {x:box.x,y:box.y,w:box.w,h:box.h,rot:box.rot || 0,flipH:box.flipH,flipV:box.flipV};const sx=t.child.w?t.w/t.child.w:1,sy=t.child.h?t.h/t.child.h:1;return {x:t.x+(box.x-t.child.x)*sx,y:t.y+(box.y-t.child.y)*sy,w:box.w*sx,h:box.h*sy,rot:box.rot || 0,flipH:box.flipH,flipV:box.flipV};}
module.exports={parsePptx,readZip,parseXml};

// ---- writing: text edits go back into the slide XML; every other part is copied through untouched
const CRC=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c;}return t;})();
function crc32(buf){let c=-1;for(let i=0;i<buf.length;i++)c=CRC[(c^buf[i])&0xff]^(c>>>8);return (c^-1)>>>0;}
function writeZip(parts){const locals=[],centrals=[];let offset=0;
 for(const p of parts){const name=Buffer.from(p.name,'utf8');const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);head.writeUInt16LE(0x0800,6);head.writeUInt16LE(p.method,8);head.writeUInt16LE(0,10);head.writeUInt16LE(0x21,12);head.writeUInt32LE(p.crc,14);head.writeUInt32LE(p.data.length,18);head.writeUInt32LE(p.usize,22);head.writeUInt16LE(name.length,26);head.writeUInt16LE(0,28);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(p.method,10);c.writeUInt16LE(0,12);c.writeUInt16LE(0x21,14);c.writeUInt32LE(p.crc,16);c.writeUInt32LE(p.data.length,20);c.writeUInt32LE(p.usize,24);c.writeUInt16LE(name.length,28);c.writeUInt16LE(0,30);c.writeUInt16LE(0,32);c.writeUInt16LE(0,34);c.writeUInt16LE(0,36);c.writeUInt32LE(0,38);c.writeUInt32LE(offset,42);
  locals.push(head,name,p.data);centrals.push(c,name);offset+=head.length+name.length+p.data.length;}
 const cd=Buffer.concat(centrals);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(parts.length,8);end.writeUInt16LE(parts.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
 return Buffer.concat([...locals,cd,end]);}
const escapeXml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// edits: [{slide:'ppt/slides/slide1.xml', index:n, paragraphs:['line','line']}]
function applyTextEdits(xml,edits){
 const blocks=[];const re=/<p:sp\b[\s\S]*?<\/p:sp>/g;let m;while((m=re.exec(xml)))blocks.push({start:m.index,end:m.index+m[0].length,text:m[0]});
 let out=xml;for(const edit of [...edits].sort((a,b)=>b.index-a.index)){const block=blocks[edit.index];if(!block)continue;
  const body=/<p:txBody>[\s\S]*?<\/p:txBody>/.exec(block.text);if(!body)continue;
  const paras=body[0].match(/<a:p\b[\s\S]*?<\/a:p>|<a:p\/>/g) || [];
  const pPrOf=p=>(/<a:pPr\b[^>]*\/>|<a:pPr\b[\s\S]*?<\/a:pPr>/.exec(p) || [''])[0];
  const rPrOf=p=>(/<a:rPr\b[^>]*\/>|<a:rPr\b[\s\S]*?<\/a:rPr>/.exec(p) || [''])[0].replace(/<a:rPr\b/,'<a:rPr').replace(/\s(?:dirty|err)="[^"]*"/g,'');
  const endOf=p=>(/<a:endParaRPr\b[^>]*\/>|<a:endParaRPr\b[\s\S]*?<\/a:endParaRPr>/.exec(p) || [''])[0];
  const lines=edit.paragraphs.map(t=>String(t).slice(0,20000));const rebuilt=[];
  for(let i=0;i<lines.length;i++){const src=paras[Math.min(i,paras.length-1)] || '<a:p/>';const pPr=pPrOf(src),rPr=rPrOf(src) || (i>0?rPrOf(paras[Math.min(i-1,paras.length-1)] || ''):'');const end=endOf(src);const segments=lines[i].split('\n');const runs=segments.map((seg,k)=>(k?'<a:br>'+(rPr?rPr:'')+'</a:br>':'')+(seg?'<a:r>'+rPr+'<a:t>'+escapeXml(seg)+'</a:t></a:r>':'')).join('');rebuilt.push('<a:p>'+pPr+runs+end+'</a:p>');}
  const bodyHead=(/<p:txBody>[\s\S]*?(?=<a:p\b|<\/p:txBody>)/.exec(body[0]) || ['<p:txBody>'])[0];
  const newBody=bodyHead+rebuilt.join('')+'</p:txBody>';
  const newBlock=block.text.slice(0,body.index)+newBody+block.text.slice(body.index+body[0].length);
  out=out.slice(0,block.start)+newBlock+out.slice(block.end);}
 return out;}
function savePptx(buffer,edits){const zip=readZip(buffer);const bySlide=new Map();for(const e of edits || []){if(!e || typeof e.slide!=='string' || !/^ppt\/slides\/[\w-]+\.xml$/.test(e.slide) || !Number.isInteger(e.index) || !Array.isArray(e.paragraphs))continue;if(!bySlide.has(e.slide))bySlide.set(e.slide,[]);bySlide.get(e.slide).push(e);}
 const parts=[];for(const name of zip.names()){if(name.endsWith('/'))continue;if(bySlide.has(name)){const xml=applyTextEdits(zip.text(name),bySlide.get(name));const data=Buffer.from(xml,'utf8');parts.push({name,method:8,data:zlib.deflateRawSync(data),usize:data.length,crc:crc32(data)});}else{const r=zip.raw(name);if(!r)continue;parts.push({name,method:r.method,data:r.data,usize:r.usize,crc:r.crc});}}
 return writeZip(parts);}
module.exports.savePptx=savePptx;module.exports.applyTextEdits=applyTextEdits;
