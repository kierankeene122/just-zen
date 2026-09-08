// Local packaging: asar with unpacked helpers, hardened Electron fuses, hardened-runtime ad hoc signature.
const path=require('node:path');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {packager}=require('@electron/packager');
const {flipFuses,FuseVersion,FuseV1Options}=require('@electron/fuses');
const root=path.resolve(__dirname,'..');
(async()=>{
 const [out]=await packager({
  dir:root,name:'Just Zen',platform:'darwin',arch:'arm64',appBundleId:'com.hearth.workspace',
  icon:path.join(root,'assets','justzen.icns'),out:process.env.ZEN_PACKAGE_OUT || path.resolve(root,'../../outputs'),overwrite:true,
  asar:{unpackDir:'node_modules',unpack:'{document-worker.cjs,document-sanitize.cjs}'},
  ignore:[/^\/smoke/,/^\/README\.md$/,/\.test\.cjs$/,/^\/\.github/,/^\/scripts/,/^\/site/,/^\/release/,/^\/SECURITY-REVIEW/,/^\/ADVERSARIAL-RESULTS\.md$/,/^\/AUDIT-SCOPE\.md$/]
 });
 const app=path.join(out,'Just Zen.app');
 // Recorded before signing so the local updater can tell which Electron a build contains.
 fs.writeFileSync(path.join(app,'Contents','Resources','build-info.json'),JSON.stringify({electron:require('electron/package.json').version,app:require(path.join(root,'package.json')).version,builtAt:new Date().toISOString()}));
 await flipFuses(app,{
  version:FuseVersion.V1,resetAdHocDarwinSignature:true,
  [FuseV1Options.RunAsNode]:false,
  [FuseV1Options.EnableCookieEncryption]:true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
  [FuseV1Options.EnableNodeCliInspectArguments]:false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,
  [FuseV1Options.OnlyLoadAppFromAsar]:true
 });
 // Ad hoc signatures carry no Team ID, so the hardened runtime cannot be enabled here (library validation would reject
 // the Electron framework). The release workflow signs with Developer ID, the hardened runtime and entitlements.mac.plist.
 execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'});
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
 console.log('Packaged',app);
})().catch(error=>{console.error(error);process.exit(1);});
