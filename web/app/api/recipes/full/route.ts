import {NextRequest} from "next/server";
import {forward} from "../../proxy";
export const POST=(req:NextRequest)=>forward(req,undefined,"/full");
