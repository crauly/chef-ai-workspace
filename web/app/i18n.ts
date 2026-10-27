export type Locale="ja"|"en-US";
export const strings={
 ja:{library:"レシピライブラリ",intro:"料理のレシピを保存し、変更できます。",newName:"新しいレシピ名",create:"レシピを作成",details:"詳細を見る",empty:"まだレシピがありません。上のフォームから追加できます。",previous:"前へ",next:"次へ",page:"ページ",detail:"レシピ詳細",close:"閉じる",rename:"料理名を変更",save:"変更して保存",ingredients:"食材・分量",noIngredients:"食材はまだ登録されていません。",unnamed:"食材名未設定",missing:"未設定",assumed:"推定",unresolved:"要確認",price:"売価",failure:"通信に失敗しました"},
 "en-US":{library:"Recipe Library",intro:"Save, revisit, and update your recipes.",newName:"New recipe name",create:"Create recipe",details:"View details",empty:"No recipes yet. Create one above.",previous:"Previous",next:"Next",page:"Page",detail:"Recipe details",close:"Close",rename:"Recipe name",save:"Save changes",ingredients:"Ingredients & quantities",noIngredients:"No ingredients added yet.",unnamed:"Ingredient name missing",missing:"Not set",assumed:"Estimated",unresolved:"Needs review",price:"Selling price",failure:"Request failed"}
} as const;
export function label(locale:Locale,key:keyof typeof strings.ja):string{return strings[locale][key];}
