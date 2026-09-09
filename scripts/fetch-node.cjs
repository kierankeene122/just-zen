// Downloads the official standalone Node.js binary for macOS arm64 matching the running version, verifies it against
// nodejs.org's SHASUMS256.txt, and returns the path to a cached `node` executable.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
async function download(url){const res=await fetch(url);if(!res.ok)throw Error(`${url}: HTTP ${res.status}`);return Buffer.from(await res.arrayBuffer());}
async function fetchNode(buildDir,version=process.version){
 const target=path.join(buildDir,'node'),stamp=path.join(buildDir,'node.version');
 if(fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp,'utf8').trim()===version)return target;
 fs.mkdirSync(buildDir,{recursive:true});
 const name=`node-${version}-darwin-arm64.tar.gz`,base=`https://nodejs.org/dist/${version}/`;
 const [tarball,sums]=await Promise.all([download(base+name),download(base+'SHASUMS256.txt')]);
 const expected=(sums.toString().split('\n').find(l=>l.endsWith('  '+name)) || '').split(' ')[0];
 const actual=crypto.createHash('sha256').update(tarball).digest('hex');
 if(!expected || expected!==actual)throw Error('Node.js download checksum mismatch for '+name);
 const tmp=fs.mkdtempSync(path.join(buildDir,'node-'));fs.writeFileSync(path.join(tmp,name),tarball);
 execFileSync('tar',['-xzf',path.join(tmp,name),'-C',tmp,'--strip-components=2',`node-${version}-darwin-arm64/bin/node`]);
 fs.copyFileSync(path.join(tmp,'node'),target);fs.chmodSync(target,0o755);fs.writeFileSync(stamp,version);fs.rmSync(tmp,{recursive:true,force:true});
 return target;
}
module.exports={fetchNode};
