import {recoverEvents} from './events';
import {dispatchFeedback} from './feedback';
import {tickMonitoring} from './monitoring';
import {maintainSupply} from './inbox';
import {searchTick} from './autonomy-search';

/** Shared local/deployed maintenance. Scheduling retains its durable lease. */
export async function runMaintenance() {
  const names=['events','feedback','monitoring','inbox','investigations','scheduler','searches'];
  const results=await Promise.allSettled([
    recoverEvents(50), dispatchFeedback(50), tickMonitoring(50), maintainSupply(),
    import('./agent/runner').then(m=>m.tickDueRuns(10)),
    import('./ops/scheduler').then(m=>m.schedulerTick()),
    searchTick(),
  ]);
  const failed:string[]=[];
  results.forEach((r,i)=>{if(r.status==='rejected'){failed.push(names[i]);console.error('Maintenance subsystem failed',names[i],r.reason);}});
  return {ok:failed.length===0,failed};
}
