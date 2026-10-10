import {searchView,advanceSearch} from '@/lib/autonomy-search';
import {apiError} from '@/lib/platform';
export async function GET(_r:Request,c:{params:Promise<{id:string}>}) {
 const {id}=await c.params;await advanceSearch(id);const value=await searchView(id);
 return value?Response.json(value):apiError(404,'NOT_FOUND','Search not found.');
}
