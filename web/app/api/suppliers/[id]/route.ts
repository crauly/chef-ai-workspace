import {NextRequest} from "next/server";
import {supplierForward} from "../forward";
export const PUT=(req:NextRequest,ctx:{params:Promise<{id:string}>})=>ctx.params.then(({id})=>supplierForward(req,id));
export const DELETE=(req:NextRequest,ctx:{params:Promise<{id:string}>})=>ctx.params.then(({id})=>supplierForward(req,id));
