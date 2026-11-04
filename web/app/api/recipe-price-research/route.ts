import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
import {enrichEntries} from "../../../price-enrichment";

export const runtime="nodejs";
const fail=(status:number,message:string)=>NextResponse.json({error:message},{status,headers:{"Cache-Control":"no-store"}});
type Row={id:string;name:string};
const selectionSchema={type:"object",properties:{indices:{type:"array",items:{type:"integer"}}},required:["indices"],additionalProperties:false};

// Research is a read-only candidate builder. Only AIEditor -> /recipes/[id]/confirm
// after explicit chef approval can persist any resulting price.
export async function POST(req:NextRequest){
 if(!await previewAuthorized(req)||req.headers.get("origin")!==req.nextUrl.origin)return fail(403,"Unauthorized");
 const apiKey=process.env.MODEL_API_KEY;
 if(!apiKey)return fail(503,"Model unavailable");
 try{
  const raw=await req.text();
  if(new TextEncoder().encode(raw).length>16000)return fail(413,"Request too large");
  const body:unknown=JSON.parse(raw);
  if(!body||typeof body!=="object"||Array.isArray(body))return fail(400,"Invalid request");
  const input=body as Record<string,unknown>;
  if(typeof input.instruction!=="string"||!input.instruction.trim()||input.instruction.length>4000||
   !Array.isArray(input.materials)||input.materials.length>40||!input.materials.length)return fail(400,"Invalid request");
  const materials:Row[]=[];
  for(const row of input.materials){
   if(!row||typeof row!=="object"||Array.isArray(row))return fail(400,"Invalid material");
   const r=row as Record<string,unknown>;
   if(typeof r.id!=="string"||!r.id||r.id.length>100||
      typeof r.name!=="string"||!r.name.trim()||r.name.length>200)return fail(400,"Invalid material");
   materials.push({id:r.id,name:r.name.trim()});
  }
  const system=`You identify EXACTLY which material rows a chef wants to research for provisional market purchase prices. The instruction can be Japanese or English. Select all rows for "全部", "すべて", "全材料", "all", and equivalents. Support named subsets, multiple names, ranges such as "AからBまで" (inclusive, by the order supplied), and contextual pronouns. Do not assume only one row is meant. Use only valid zero-based indices from the provided materials list. If the scope cannot be determined confidently, return an empty indices array. This is selection ONLY, never a price estimate or authorization.`;
  const response=await fetch("https://api.meta.ai/v1/chat/completions",{
   method:"POST",headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},
   body:JSON.stringify({model:"muse-spark-1.3",reasoning_effort:"low",max_completion_tokens:1024,
    response_format:{type:"json_schema",json_schema:{name:"recipe_price_scope",strict:true,schema:selectionSchema}},
    messages:[{role:"developer",content:system},{role:"user",content:JSON.stringify({instruction:input.instruction,materials:materials.map((m,i)=>({index:i,name:m.name}))})}]}),
   cache:"no-store",redirect:"error",signal:AbortSignal.timeout(25000)
  });
  if(!response.ok)return fail(502,"Scope selection failed");
  const model:unknown=await response.json();
  const choices=model&&typeof model==="object"?(model as {choices?:unknown}).choices:null;
  if(!Array.isArray(choices)||choices.length!==1)return fail(502,"Invalid selection");
  const choice=choices[0] as {message?:{content?:unknown}};
  if(typeof choice?.message?.content!=="string")return fail(502,"Invalid selection");
  const parsed:unknown=JSON.parse(choice.message.content);
  if(!parsed||typeof parsed!=="object"||!Array.isArray((parsed as {indices?:unknown}).indices))return fail(502,"Invalid selection");
  const indices=(parsed as {indices:unknown[]}).indices;
  if(!indices.every(i=>typeof i==="number"&&Number.isInteger(i)&&i>=0&&i<materials.length))return fail(502,"Invalid indices");
  const unique=[...new Set(indices as number[])].sort((a,b)=>a-b);
  if(!unique.length)return NextResponse.json({indices:[],operations:[],results:[],ambiguous:true},{headers:{"Cache-Control":"no-store"}});
  const entries=unique.map(i=>({material_name:materials[i].name,material_index:i,request:input.instruction as string,trigger:"muse" as const}));
  const results:{index:number;name:string;status:string;description:string}[]=[];
  const operations:Record<string,string>[]=[];
  // Bound concurrency limits external Meta Search Grounding calls, not the total
  // number of requested rows. "All" never silently truncates the selection.
  for(let offset=0;offset<entries.length;offset+=3){
   const batch=entries.slice(offset,offset+3);
   const {priceReferences}=await enrichEntries(apiKey,batch);
   priceReferences.forEach((ref,j)=>{
    const row=materials[batch[j].material_index];
    const usable=ref.status==="available"&&ref.currency==="JPY"&&
     typeof ref.average_unit_price==="string"&&/^(?:0|[1-9]\\d*)(?:\\.\\d+)?$/.test(ref.average_unit_price)&&Number(ref.average_unit_price)>0&&
     (ref.unit_basis==="g"||ref.unit_basis==="ml");
    results.push({index:batch[j].material_index,name:row.name,
     status:usable?"candidate":ref.status==="available"?"unsupported_unit":ref.status,description:ref.text});
    if(usable)operations.push({op:"set_material_price",material_id:row.id,
     price_jpy:ref.average_unit_price!,price_quantity:"1",price_unit:ref.unit_basis!});
   });
  }
  return NextResponse.json({indices:unique,operations,results,ambiguous:false},{headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502,"Price research failed");}
}
