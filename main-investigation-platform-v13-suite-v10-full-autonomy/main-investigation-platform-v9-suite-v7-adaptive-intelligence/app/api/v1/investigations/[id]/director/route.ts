import { apiError,getD1 } from '@/lib/platform';
import { directorView,directInvestigation } from '@/lib/director/director';
async function idOf(value:string){return getD1().prepare('SELECT id FROM investigations WHERE id=? OR external_id=?').bind(value,value).first<{id:string}>();}
export async function GET(_request:Request,ctx:{params:Promise<{id:string}>}) {const inv=await idOf((await ctx.params).id);return inv?Response.json(await directorView(inv.id)):apiError(404,'NOT_FOUND','Investigation not found.');}
export async function POST(_request:Request,ctx:{params:Promise<{id:string}>}) {const inv=await idOf((await ctx.params).id);return inv?Response.json(await directInvestigation(inv.id)):apiError(404,'NOT_FOUND','Investigation not found.');}
