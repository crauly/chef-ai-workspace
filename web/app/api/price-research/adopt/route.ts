import {NextRequest} from 'next/server';
import {researchProxy} from '../route';
export async function POST(req:NextRequest){return researchProxy(req,true);}
