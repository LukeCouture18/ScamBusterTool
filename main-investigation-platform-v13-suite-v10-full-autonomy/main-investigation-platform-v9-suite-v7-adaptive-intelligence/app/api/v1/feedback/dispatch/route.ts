import {apiError} from "@/lib/platform";
import {dispatchFeedback} from "@/lib/feedback";
import {recoverEvents} from "@/lib/events";
export async function POST(){try{const events=await recoverEvents(25);return Response.json({events,feedback:await dispatchFeedback(50)});}catch(error){return apiError(500,"FEEDBACK_DISPATCH_ERROR",error instanceof Error?error.message:"Feedback dispatch failed");}}
