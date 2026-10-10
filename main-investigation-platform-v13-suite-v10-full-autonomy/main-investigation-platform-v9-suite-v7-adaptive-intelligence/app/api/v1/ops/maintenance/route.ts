import {runMaintenance} from '@/lib/maintenance';
/** Local launcher counterpart to the scheduled Worker, under the same leases/budgets. */
export async function POST(){const result=await runMaintenance();return Response.json(result,{status:result.ok?200:503});}
