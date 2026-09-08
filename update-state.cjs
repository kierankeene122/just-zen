// Turns the local updater's state file into the one-line status shown on the Security page.
function describeUpdateState(state){
 if(!state || !state.checkedAt)return 'Local updater has not run yet';
 const when=new Date(state.checkedAt);const day=Number.isNaN(when.getTime())?'':' · checked '+when.toLocaleDateString(undefined,{day:'numeric',month:'short'});
 if(state.staged)return `New build ready (Electron ${state.stagedElectron || state.latest || ''}) · quit Just Zen to install`.replace(' ()','');
 if(state.status==='failed')return 'Last local update failed · see ~/Library/Logs/Just Zen/update.log';
 if(state.status==='offline')return 'Local updater could not reach the registry'+day;
 const major=state.newerMajor?` · Electron ${state.newerMajor} available, needs a manual upgrade`:'';
 return `Local updater · Electron ${state.latest || state.installed || ''} current${day}${major}`;
}
module.exports={describeUpdateState};
