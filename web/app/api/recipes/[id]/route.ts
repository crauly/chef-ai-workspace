import {NextRequest} from "next/server";
import {forward} from "../../proxy";
export async function GET(req: NextRequest, {params}: {params: Promise<{id: string}>}) {
  return forward(req, (await params).id);
}
