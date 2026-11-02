import {NextRequest} from "next/server";
import {supplierForward} from "./forward";
export const GET=(req:NextRequest)=>supplierForward(req);
export const POST=(req:NextRequest)=>supplierForward(req);
