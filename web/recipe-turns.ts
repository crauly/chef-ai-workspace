// Pack chronological fragments without dropping an early utterance after a failed initial parse.
export function prepareRecipeTurns(turns:string[]):string[]{
 if(turns.length<=30)return [...turns];
 const packed:string[]=[];
 for(const turn of turns){
  if(turn.length>1000)throw new Error('utterance_too_long');
  if(packed.length&&packed[packed.length-1].length+turn.length+1<=1000)packed[packed.length-1]+='\n'+turn;
  else packed.push(turn);
 }
 if(packed.length>30)throw new Error('too_many_turns');
 return packed;
}

// Count the serialized UTF-8 body, not JS characters. Never split or drop an
// unparsed ASR fragment. Completed facts remain in previous when raw history
// no longer fits. The caller advances count only after a successful response.
export function recipeRequestBatch(turns:string[],offset:number,previous:unknown){
 const fits=(body:object)=>new TextEncoder().encode(JSON.stringify(body)).length<=64000;
 let transcript="",count=0;
 for(const turn of turns.slice(offset)){
  const next=transcript?transcript+"\n"+turn:turn;
  const body={transcript:next,...(previous?{previous}:{}),defer_prices:true};
  if(next.length>30000||!fits(body))break;
  transcript=next;count++;
 }
 if(!count)throw new Error('recipe_context_too_large');
 const body:{transcript:string;previous?:unknown;history?:string;defer_prices:boolean}={transcript,...(previous?{previous}:{}),defer_prices:true};
 const history=turns.slice(0,offset).join("\n");
 if(history&&history.length+transcript.length+1<=30000&&fits({...body,history}))body.history=history;
 return {body,count};
}
