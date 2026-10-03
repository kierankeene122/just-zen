#!/usr/bin/env node
// The release is blocked by any vulnerability we can actually do something about.
// An advisory with no published fix anywhere in the tree is reported loudly and does not block the build,
// because holding every release hostage to someone else's unreleased patch helps nobody.
const {execFile}=require('node:child_process');

execFile('npm',['audit','--omit=dev','--json'],{maxBuffer:32*1024*1024},(error,stdout)=>{
  let report;
  try{report=JSON.parse(stdout);}catch{
    console.error('Could not read the audit report.');
    console.error(String(stdout).slice(0,2000));
    process.exit(1);
  }
  const advisories=Object.values(report.vulnerabilities || {});
  const hasFix=item=>Boolean(item.fixAvailable) && item.fixAvailable!==false;
  // A "fix" that is really a breaking downgrade of a dependency is a decision for a person, not a release gate.
  const breaking=item=>typeof item.fixAvailable==='object' && item.fixAvailable.isSemVerMajor===true;
  const fixable=advisories.filter(item=>hasFix(item) && !breaking(item));
  const needsDecision=advisories.filter(item=>hasFix(item) && breaking(item));
  const unfixable=advisories.filter(item=>!hasFix(item));
  for(const item of needsDecision){
    const to=item.fixAvailable.name+'@'+item.fixAvailable.version;
    console.log(`needs a decision · ${item.name} (${item.severity}) · the only published fix is a breaking change to ${to}`);
  }

  for(const item of unfixable){
    const via=(item.via || []).map(v=>typeof v==='string'?v:v.title).filter(Boolean)[0] || 'advisory';
    console.log(`known, no fix published yet · ${item.name} (${item.severity}) · ${via}`);
  }
  if(!fixable.length){
    console.log(`npm audit: ${advisories.length} advisories, none fixable without a breaking change.`);
    return;
  }
  for(const item of fixable){
    const via=(item.via || []).map(v=>typeof v==='string'?v:v.title).filter(Boolean)[0] || 'advisory';
    console.error(`FIXABLE · ${item.name} (${item.severity}) · ${via}`);
  }
  console.error(`\n${fixable.length} vulnerabilities have a fix. Run "npm audit fix" and commit the lockfile.`);
  process.exit(1);
});
