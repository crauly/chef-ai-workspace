import type {VoiceMode} from "./VoiceModePanel";
export type Navigation={mode:Exclude<VoiceMode,"idle">;target:string};
export function explicitEditRequest(text:string):boolean{
 if(/(?:変更|修正|訂正|追加)(?:は)?(?:しない|しません)/.test(text))return false;
 return /(?:変更|修正|訂正|追加)(?:して|します|する|したい|[。.!！]?$)|差し替|増や|減ら|にして|にする|に変え|を抜いて|を入れて|\b(?:change|set|increase|decrease|replace|add)\b/i.test(text);
}

// Match explicit navigation as a whole request. Recipe corrections remain data.
export function voiceNavigation(raw:string):Navigation|null{
 const text=raw.normalize("NFKC").trim().replace(/[。.!！?？]+$/g,"").replace(/^(?:えー[、, ]*|はい[、, ]*)/,"");
 const create=text.match(/^(?:(?:新しい|新規の?)?(?:レシピ|メニュー)(?:を)?(?:登録|作成)(?:します|したい|してください|して|する)?|新規登録|登録モード|新しい(?:レシピ|メニュー))(?:[、。,:：\s]+(.+))?$/);
 if(create)return {mode:"create",target:create[1]??""};
 if(/^(?:レシピの?)?(?:参照|呼び出し|検索)(?:モード)?(?:にして|に切り替えて)?$/.test(text))return {mode:"browse",target:""};
 if(/^(?:(?:この|その)?(?:レシピ|メニュー)(?:の|を)?|これを)?(?:編集|修正)(?:モード)?(?:にして|に切り替えて|します|したい|してください|して)?$/.test(text))return {mode:"edit",target:""};
 const edit=text.match(/^(.+?)(?:のレシピ)?を(?:編集|修正)(?:してください|して|したい)$/);
 if(edit)return {mode:"edit",target:edit[1]};
 const browse=text.match(/^(?:(?:レシピ|メニュー)(?:の)?[「『]?(.+?)[」』]?(?:を)?|(.+?)(?:のレシピ)?(?:を)?)(?:見せて|表示して|呼び出して|探して|検索して)(?:ください)?$/);
 if(browse)return {mode:"browse",target:(browse[1]??browse[2]).replace(/(?:のレシピ|を)$/g,"").trim()};
 const english=text.match(/^(?:new|create|register)(?: a)? recipe(?:[ :]+(.+))?$/i);
 if(english)return {mode:"create",target:english[1]??""};
 const show=text.match(/^(?:show|find|search)(?: recipe)?[ :]+(.+)$/i);
 if(show)return {mode:"browse",target:show[1]};
 if(/^(?:edit|edit recipe)$/i.test(text))return {mode:"edit",target:""};
 return null;
}
