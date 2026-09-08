// Reads CodeQL SARIF output and fails the job on any finding. Used instead of the code-scanning upload,
// which private repositories cannot use without GitHub Advanced Security.
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[2] || 'codeql-results';
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.sarif')):[];
if(!files.length){console.error('No SARIF output found in '+dir);process.exit(1);}
let count=0;
for(const file of files){
 const sarif=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
 for(const run of sarif.runs || []){
  const rules=new Map((run.tool?.driver?.rules || []).map(r=>[r.id,r]));
  for(const result of run.results || []){
   count++;const rule=rules.get(result.ruleId);const loc=result.locations?.[0]?.physicalLocation;
   console.log(`${result.level || rule?.defaultConfiguration?.level || 'warning'}: ${result.ruleId} at ${loc?.artifactLocation?.uri || '?'}:${loc?.region?.startLine || '?'}\n  ${result.message?.text || ''}`);
  }
 }
}
if(count){console.error(`CodeQL reported ${count} finding(s).`);process.exit(1);}
console.log('CodeQL: no findings.');
