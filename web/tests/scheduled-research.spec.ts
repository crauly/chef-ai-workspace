import {test,expect} from '@playwright/test';
const ingredient='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
for(const width of [390,1280])test(`global settings persist and candidates require approval at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:844});
 let settings={enabled:false,interval_hours:24},adopts=0;
 let candidates=[{id:ingredient,name:'パスタ',amount_jpy:'400',quantity:'500',unit:'g',observed_at:'2026-11-04T10:00:00Z',source_url:'https://shop.example/pasta',supplier_name:'相場参考価格',evidence:{name:'パスタ500g',seller:'店舗'},current_price:{amount_jpy:{value:'350'},per_quantity:'500',per_unit:'g'},offer_price:'350',offer_adopted_id:null,basis_offer_id:null,ingredient_adopted_id:null,basis_ingredient_id:null,stale:false}];
 await page.route('**/api/price-research',route=>{if(route.request().method()==='PATCH')settings=route.request().postDataJSON();return route.fulfill({json:{settings,candidates}});});
 await page.route('**/api/price-research/adopt',route=>{adopts++;expect(route.request().postDataJSON()).toEqual({observation_id:ingredient});candidates=[];return route.fulfill({json:{adopted:true}});});
 await page.goto('/settings?section=research');const panel=page.getByRole('region',{name:'定期価格調査の設定と候補',exact:true});
 await expect(panel.getByRole('switch')).not.toBeChecked();await panel.getByRole('switch').check();await panel.getByLabel('調査間隔（時間）').fill('12');await panel.getByRole('button',{name:'設定を保存'}).click();
 await page.reload();await expect(panel.getByRole('switch')).toBeChecked();await expect(panel.getByLabel('調査間隔（時間）')).toHaveValue('12');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await expect(panel).toContainText('参考候補: ¥400 / 500 g');await expect(panel.getByRole('link',{name:'調査元を確認'})).toHaveAttribute('href','https://shop.example/pasta');expect(adopts).toBe(0);
 page.once('dialog',d=>d.dismiss());await panel.getByRole('button',{name:'条件を確認して価格を採用'}).click();expect(adopts).toBe(0);
 page.once('dialog',d=>d.accept());await panel.getByRole('button',{name:'条件を確認して価格を採用'}).click();await expect.poll(()=>adopts).toBe(1);await expect(panel).toContainText('価格候補はありません。');
});
test('ingredient registration and edit retain the per-ingredient flag',async({page})=>{
 let item:{id:string;name:string;spec:null;price_research_enabled:boolean}|null=null;
 await page.route('**/api/ingredients',route=>{if(route.request().method()==='POST'){const body=route.request().postDataJSON();item={id:ingredient,name:body.name,spec:null,price_research_enabled:body.price_research_enabled};return route.fulfill({status:201,json:{id:ingredient}});}return route.fulfill({json:{items:item?[item]:[],suppliers_by_ingredient:{}}});});
 await page.route('**/api/ingredients/'+ingredient,route=>{if(item)item.price_research_enabled=route.request().postDataJSON().price_research_enabled;return route.fulfill({json:{updated:true}});});
 await page.route('**/api/suppliers?**',route=>route.fulfill({json:{items:[]}}));await page.route('**/api/ingredients/*/offer-prices',route=>route.fulfill({json:{items:[]}}));
 await page.goto('/settings?section=ingredient');await page.getByRole('button',{name:'+ 新規登録',exact:true}).click();await page.getByLabel('新規食材名', {exact:true}).fill('調査パスタ');
 const flag=page.getByRole('switch',{name:'この食材を定期価格調査の対象にする'});await expect(flag).not.toBeChecked();await flag.check();await page.getByRole('button',{name:'食材を登録',exact:true}).click();
 await page.reload();await page.getByRole('row',{name:/調査パスタ/}).getByRole('button',{name:'編集',exact:true}).click();const dialog=page.getByRole('dialog',{name:'調査パスタを編集'});await expect(dialog.getByRole('switch')).toBeChecked();await dialog.getByRole('switch').uncheck();await dialog.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByRole('row',{name:/調査パスタ/}).getByRole('button',{name:'編集',exact:true}).click();await expect(dialog.getByRole('switch')).not.toBeChecked();
});
