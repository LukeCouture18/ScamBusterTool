import { replayEvent } from "@/lib/events";
import { apiError } from "@/lib/platform";
export async function POST(_:Request,context:{params:Promise<{id:string}>}){try{const {id}=await context.params;const event=await replayEvent(id);if(!event)return apiError(404,"EVENT_NOT_FOUND","Event not found.");return Response.json({event});}catch(error){return apiError(500,"EVENT_REPLAY_ERROR",error instanceof Error?error.message:"Unable to replay event");}}
