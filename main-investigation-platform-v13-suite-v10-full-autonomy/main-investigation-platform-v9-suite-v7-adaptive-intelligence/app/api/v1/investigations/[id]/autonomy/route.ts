import { apiError } from '@/lib/platform';
import { autonomyView, continueInvestigation } from '@/lib/autonomy';
export async function GET(_r:Request,c:{params:Promise<{id:string}>}){const v=await autonomyView((await c.params).id);return v?Response.json(v):apiError(404,'NOT_FOUND','Investigation not found.');}
export async function POST(_r:Request,c:{params:Promise<{id:string}>}){const v=await continueInvestigation((await c.params).id);return v?Response.json(v):apiError(404,'NOT_FOUND','Investigation not found.');}
