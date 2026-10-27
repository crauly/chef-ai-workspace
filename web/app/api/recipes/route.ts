import {NextRequest} from "next/server";
import {forward} from "../proxy";
export const GET = (req: NextRequest) => forward(req);
export const POST = (req: NextRequest) => forward(req);
