import { z } from 'zod';
import { apiError, readJsonBody } from '@/lib/platform';
import { autonomyDashboard, investigateSite } from '@/lib/autonomy';
import {startInvestigation} from '@/lib/autonomy-search';
export async function GET(){return Response.json(await autonomyDashboard());}
export async function POST(request:Request){try{const {site,request_id}=z.object({site:z.string().min(3).max(4096).optional(),request_id:z.string().min(8).max(80).optional()}).strict().parse(await readJsonBody(request));return Response.json(site?await investigateSite(site):await startInvestigation(request_id),{status:202});}catch(e){return apiError(400,'START_FAILED',e instanceof Error?e.message:'Unable to start investigation.');}}
