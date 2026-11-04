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
