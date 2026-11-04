import {NextRequest} from 'next/server';
import {forward} from '../../../../proxy';
export const POST=async(req:NextRequest,{params}:{params:Promise<{id:string}>})=>forward(req,(await params).id,'/confirm/review');
