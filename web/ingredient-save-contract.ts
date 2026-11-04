export const ingredientSaveCodes=['unit_unknown','supplier_unavailable','ingredient_conflict','invalid_price','invalid_input','ingredient_unavailable','request_conflict','price_confirmation_required','api_unavailable','database_error'] as const;
export type IngredientSaveCode=typeof ingredientSaveCodes[number];
export function safeIngredientSaveCode(value:unknown):IngredientSaveCode|null{return typeof value==='string'&&(ingredientSaveCodes as readonly string[]).includes(value)?value as IngredientSaveCode:null;}
export function ingredientSaveMessage(code:unknown,ja:boolean){
 const messages:Record<IngredientSaveCode,[string,string]>={
  unit_unknown:['仕入単位が単位マスターに登録されていません。単位を選択するか、単位管理で登録して一覧を更新してください。','Select a registered unit, or register it in Units and refresh the list.'],
  supplier_unavailable:['選択した仕入れ先が存在しないか、使用できません。仕入れ先を選び直してください。','The selected supplier is unavailable. Choose a supplier again.'],
  ingredient_conflict:['同じ食材名・規格、または仕入れ条件が競合しています。登録済みの内容を確認してください。','Ingredient identity or purchase terms conflict with existing records.'],
  invalid_price:['価格は0以上、仕入数量は0より大きい数値で入力し、仕入単位も選択してください。登録済み価格は空欄では削除できません。','Enter a nonnegative price, a positive quantity and a unit. Existing prices cannot be removed by clearing fields.'],
  invalid_input:['食材名・規格・入力内容を確認してください。','Check the ingredient name, specification and entered values.'],
  ingredient_unavailable:['この食材は削除されたか、使用できません。一覧を更新してください。','This ingredient is unavailable. Refresh the list.'],
  request_conflict:['前回の保存要求と内容が一致しません。保存結果を確認してから編集を開き直してください。','The retry differs from the original save. Check the result and reopen the editor.'],
  price_confirmation_required:['価格・数量・単位・仕入れ先を確認して承認してください。','Review and approve the price, quantity, unit and supplier.'],
  api_unavailable:['APIとの通信に失敗しました。入力は保持しています。再試行では同じ登録IDを使用します。','API communication failed. Inputs are retained; retry uses the same request ID.'],
  database_error:['データベースの保存を確認できませんでした。入力は保持しています。同じ内容で再試行してください。','Database save could not be confirmed. Inputs are retained; retry the same values.']
 };return messages[safeIngredientSaveCode(code)??'database_error'][ja?0:1];
}
export type IngredientSavePayload={request_id:string;name:string;spec:string|null;price_research_enabled:boolean;supplier_id:string|null;purchase:{amount_jpy:string;quantity:string;unit:string}|null;price_confirmed:boolean};
