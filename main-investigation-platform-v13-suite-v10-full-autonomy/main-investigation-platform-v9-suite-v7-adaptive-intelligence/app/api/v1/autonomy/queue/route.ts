import {autonomyQueue} from '@/lib/autonomy-queue';
export async function GET(request:Request){return Response.json(await autonomyQueue(new URL(request.url).searchParams.get('investigation')??undefined));}
