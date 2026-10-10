import {apiError} from "@/lib/platform";
import {tickMonitoring} from "@/lib/monitoring";
export async function POST(){try{return Response.json({outcomes:await tickMonitoring(20)});}catch(error){return apiError(500,"MONITORING_TICK_ERROR",error instanceof Error?error.message:"Unable to schedule rechecks");}}
