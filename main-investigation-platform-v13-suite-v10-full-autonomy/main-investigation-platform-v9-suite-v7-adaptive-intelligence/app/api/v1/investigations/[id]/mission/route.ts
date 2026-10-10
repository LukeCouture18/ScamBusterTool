import {missionView} from '@/lib/missions';import {apiError} from '@/lib/platform';
export async function GET(_r:Request,c:{params:Promise<{id:string}>}) {const value=await missionView((await c.params).id);return value?Response.json(value):apiError(404,'NOT_FOUND','Mission not found.');}
