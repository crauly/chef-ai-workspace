import {voiceInput} from "./voice-input";
import {test,expect,type Page} from "@playwright/test";
import {editVoiceCommand} from "../app/voice-commands";
import {voiceNavigation,explicitEditRequest} from "../app/voice-navigation";

const recipeDraft={title:"片栗粉のレシピ",materials:[{name:"片栗粉",quantity:"10",unit:"g",price_jpy:"1000",price_quantity:"1",price_unit:"kg"}],selling_price_jpy:"1000",missing:[],notes:[]};
const type = voiceInput;
test.beforeEach(async({request})=>{await request.post("http://127.0.0.1:8100/test/reset");});

test("navigation matches whole requests and leaves quantities, negation and quoted names as data",()=>{
 expect(voiceNavigation("レシピを登録します")).toEqual({mode:"create",target:""});
 expect(voiceNavigation("新しいメニュー")).toEqual({mode:"create",target:""});
 expect(voiceNavigation("レシピを登録します、カルボナーラ、卵100g")).toEqual({mode:"create",target:"カルボナーラ、卵100g"});
 expect(voiceNavigation("片栗粉のレシピを見せて")).toEqual({mode:"browse",target:"片栗粉"});
 expect(voiceNavigation("レシピの編集モード")).toEqual({mode:"edit",target:""});
 expect(voiceNavigation("片栗粉のレシピを編集して")).toEqual({mode:"edit",target:"片栗粉"});
 for(const input of ["パスタを150gに変更","登録しないでください","登録という名前のパスタ100g"])
  expect(voiceNavigation(input)).toBeNull();
 expect(explicitEditRequest("パスタを150gに変更してください")).toBe(true);
 expect(explicitEditRequest("パスタは変更しないでください")).toBe(false);
 expect(explicitEditRequest("ありがとう")).toBe(false);
 expect(explicitEditRequest("卵を10g追加、価格は未定。片栗粉を500円に変更、仕入先は東京市場")).toBe(true);
 expect(voiceNavigation("片栗粉のレシピを開いて")).toEqual({mode:"browse",target:"片栗粉"});
 expect(editVoiceCommand("承認して保存")).toBe("save");
 expect(editVoiceCommand("保存しないでください")).toBe("hold");
});

test("one uninterrupted microphone creates, saves, browses and edits the saved recipe",async({page,request})=>{
 await page.addInitScript(()=>{
  (window as any).voiceDocument=crypto.randomUUID();(window as any).voiceStreams={opens:0,stops:0};
  const Native=window.AudioContext;
  window.AudioContext=class extends Native{
   createMediaStreamDestination(){const out=super.createMediaStreamDestination();(window as any).voiceStreams.opens++;for(const track of out.stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{(window as any).voiceStreams.stops++;stop();};}return out;}
  };
 });
 const created={...recipeDraft,title:"継続音声パスタ"};let saves=0;
 await page.route("**/api/voice-recipe",r=>r.fulfill({json:created}));
 page.on('request',r=>{if(r.url().endsWith('/recipes/full'))saves++;});
 await page.goto('/');const documentId=await page.evaluate(()=>(window as any).voiceDocument);
 await type(page,'レシピを登録します');await expect(page.locator('#voice-controls')).toContainText('現在のモード: 登録');
 await type(page,'継続音声パスタ、片栗粉10g、1kg1000円');await expect(page.getByLabel('未保存のレシピ下書き')).toBeVisible();
 await type(page,'保存');await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);const savedId=page.url().split('/').pop()!;expect(saves).toBe(1);
 await type(page,'継続音声パスタのレシピを開いて');await expect(page.getByRole('heading',{name:'継続音声パスタ',exact:true})).toBeVisible();
 await type(page,'片栗粉を15gに変更');await expect(page.getByRole('dialog',{name:'変更案の確認'})).toBeVisible();
 await type(page,'承認して保存');await expect(page.getByRole('dialog',{name:'変更案の確認'})).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Recipe cost summary'})).toContainText('¥15');
 const stored=await (await request.get('/api/recipes/'+savedId)).json();expect(stored.revision).toBe(1);expect(stored.materials[0].quantity.value).toBe('15');
 await type(page,'きのこのクリームスープを開いて');await expect(page.getByRole('heading',{name:'きのこのクリームスープ',exact:true})).toBeVisible();
 await type(page,'ミートソースパスタを編集して');await expect(page.getByRole('heading',{name:'ミートソースパスタ',exact:true})).toBeVisible();await expect(page.locator('#voice-controls')).toContainText('現在のモード: 編集');
 await page.goBack();await expect(page.getByRole('heading',{name:'きのこのクリームスープ',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).voiceDocument)).toBe(documentId);expect(await page.evaluate(()=>(window as any).voiceStreams)).toEqual({opens:1,stops:0});
 expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(1);
 await expect(page.getByRole('button',{name:'■ マイクを停止',exact:true})).toBeVisible();
});

test("switching preserves registration draft and refuses to lose an unapproved edit",async({page,request})=>{
 let parses=0;await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:recipeDraft});});
 await page.goto("/");await type(page,"片栗粉10g、1kg1000円");await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await type(page,"内容を確認");await expect(page.getByRole("button",{name:"承認して保存",exact:true})).toBeEnabled();
 await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"レシピを登録します");await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("片栗粉のレシピ");expect(parses).toBe(1);
 await expect(page.getByRole("button",{name:"レシピを登録",exact:true})).toBeEnabled();
 await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"片栗粉を15gに変更");await expect(page.getByLabel("提案の差分")).toBeVisible();
 await type(page,"新しいメニュー");await expect(page.locator("#voice-controls")).toContainText("未保存の変更案があります");
 await expect(page.getByLabel("提案の差分")).toBeVisible();
 await type(page,"変更案を破棄");await type(page,"新しいメニュー");await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
});

test("ambiguous navigation stays put; a named edit resolves the recipe without writing",async({page,request})=>{
 await page.route("**/api/intent",route=>route.fulfill({json:{intent:"clarify",target:""}}));
 await page.goto("/");await type(page,"レシピを参照したいような、登録したいような");
 await expect(page.locator("#voice-controls")).toContainText("切り替え先を確認できませんでした");
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 待機");
 await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"ありがとう");await expect(page.locator("#voice-controls")).toContainText("参照モードのままです");
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 参照");
 await type(page,"片栗粉のレシピを編集して");
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 編集");
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥10");
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
});

test("approval queued before an edit proposal is displayed cannot approve that proposal",async({page,request})=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let started!:()=>void;const sending=new Promise<void>(resolve=>{started=resolve;});
 await page.route("**/propose",async route=>{started();await held;await route.continue();});
 await page.goto("/");await type(page,"片栗粉のレシピを見せて");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await type(page,"片栗粉を15gに変更");await sending;
 await type(page,"保存してください");release();await expect(page.getByLabel("提案の差分")).toBeVisible();
 await expect(page.locator("#voice-controls")).not.toContainText("操作を処理中");
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(0);
 await type(page,"保存してください");await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥15");
 expect((await (await request.get("http://127.0.0.1:8100/test/state")).json()).confirms).toHaveLength(1);
});


test("an intent failure does not stall already accepted recipe speech",async({page})=>{
 let release!:()=>void;const held=new Promise<void>(r=>release=r);let intentStarted=false,parses=0;
 await page.route('**/api/intent',async r=>{intentStarted=true;await held;await r.fulfill({status:503,json:{error:'unavailable'}});});
 await page.route('**/api/voice-recipe',r=>{parses++;return r.fulfill({json:recipeDraft});});
 await page.goto('/');await type(page,'レシピを参照したいような、登録したいような');await expect.poll(()=>intentStarted).toBe(true);await type(page,'片栗粉10g');release();await expect(page.getByLabel('未保存のレシピ下書き')).toBeVisible();expect(parses).toBe(1);
});

test("an empty edit explains the unresolved change without posting an empty review",async({page})=>{
 let reviews=0;page.on('request',r=>{if(r.url().endsWith('/confirm/review'))reviews++;});
 await page.route('**/propose',r=>r.fulfill({json:{recipe_id:'11111111-1111-4111-8111-111111111111',base_revision:0,requires_confirmation:true,operations:[]}}));
 await page.goto('/');await type(page,'片栗粉のレシピを開いて');await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();await type(page,'食材を少し変更して');await expect(page.getByText('変更できる項目を特定できませんでした。',{exact:false})).toBeVisible();expect(reviews).toBe(0);await expect(page.locator('#ai-instruction')).toHaveValue('食材を少し変更して');
});

test("voice editing adds an unpriced ingredient and approves owned supplier and price changes",async({page,request})=>{
 const createdSupplier=await request.post('/api/suppliers',{headers:{Origin:'http://localhost:3100'},data:{name:'東京市場'}});expect(createdSupplier.ok()).toBe(true);const supplier=await createdSupplier.json();const rid='11111111-1111-4111-8111-111111111111',mid='22222222-2222-4222-8222-222222222222',added='77777777-7777-4777-8777-777777777777';
 await page.route('**/propose',r=>r.fulfill({json:{recipe_id:rid,base_revision:0,requires_confirmation:true,supplier_names:{[supplier.id]:'東京市場'},operations:[{op:'add_unpriced_material',material_id:added,name:'卵',quantity:'10',unit:'g'},{op:'set_material_supplier',material_id:mid,supplier_id:supplier.id},{op:'set_material_price',material_id:mid,price_jpy:'500',price_quantity:'1',price_unit:'kg'}]}}));
 await page.goto('/');await type(page,'片栗粉のレシピを開いて');await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();await type(page,'卵を10g追加、価格は未定。片栗粉の仕入先を東京市場に変更、1kg500円');
 const dialog=page.getByRole('dialog',{name:'変更案の確認'});await expect(dialog).toBeVisible();await expect(dialog.locator('ol')).toContainText('東京市場');await expect(dialog).toContainText('価格未確定');await expect(dialog).toContainText('500');await type(page,'承認して保存');await expect(dialog).toHaveCount(0);
 const stored=await (await request.get('/api/recipes/'+rid)).json();expect(stored.materials.find((m:any)=>m.id===added)).toMatchObject({price_mode:'inherit',price_override:null,quantity:{value:'10'}});expect(stored.materials.find((m:any)=>m.id===mid)).toMatchObject({supplier_id:supplier.id,price_override:{amount_jpy:{value:'500'}}});
 await page.reload();await page.locator('.recipe-gap-disclosure summary').click();await expect(page.locator('.recipe-gap-disclosure')).toContainText('卵：仕入単価');
});

test('self review: back invalidates the old proposal while the next recipe loads',async({page,request})=>{
 const first='11111111-1111-4111-8111-111111111111';let release!:()=>void;const held=new Promise<void>(r=>release=r);let loading=false;
 await page.goto('/');await type(page,'片栗粉のレシピを開いて');await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();await type(page,'ミートソースパスタを開いて');await expect(page.getByRole('heading',{name:'ミートソースパスタ',exact:true})).toBeVisible();await type(page,'パスタを15gに変更');await expect(page.getByRole('dialog',{name:'変更案の確認'})).toBeVisible();
 await page.route('**/api/recipes/'+first,async r=>{loading=true;await held;await r.fallback();});await page.goBack();await expect.poll(()=>loading).toBe(true);
 try{await expect(page.getByRole('dialog',{name:'変更案の確認'})).toHaveCount(0);await type(page,'承認して保存');expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(0);}finally{release();}
 await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'■ マイクを停止',exact:true})).toBeVisible();
});

test('self review: a late successful save cannot replace the recipe reached by back',async({page,request})=>{
 const first='11111111-1111-4111-8111-111111111111',second='33333333-3333-4333-8333-333333333333';let release!:()=>void;const held=new Promise<void>(r=>release=r);let saving=false;
 await page.goto('/');await type(page,'片栗粉のレシピを開いて');await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();await type(page,'ミートソースパスタを開いて');await expect(page.getByRole('heading',{name:'ミートソースパスタ',exact:true})).toBeVisible();await type(page,'パスタを15gに変更');await expect(page.getByRole('dialog',{name:'変更案の確認'})).toBeVisible();
 await page.route('**/api/recipes/'+second+'/confirm',async r=>{saving=true;await held;await r.fallback();});await type(page,'保存してください');await expect.poll(()=>saving).toBe(true);await page.goBack();await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();const completed=page.waitForResponse(r=>r.url().endsWith('/'+second+'/confirm'));release();await completed;
 await expect.poll(async()=>(await (await request.get('/api/recipes/'+second)).json()).revision).toBe(1);await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();expect(page.url()).toContain('/recipes/'+first);expect((await (await request.get('/api/recipes/'+first)).json()).revision).toBe(0);
});

test('self review: a late registration save preserves the recipe reached by back',async({page,request})=>{
 const first='11111111-1111-4111-8111-111111111111';let release!:()=>void;const held=new Promise<void>(r=>release=r);let payload:any=null;
 await page.route('**/api/voice-recipe',r=>r.fulfill({json:{...recipeDraft,title:'遅延パスタ'}}));await page.route('**/api/recipes/full',async r=>{payload=r.request().postDataJSON();await held;await r.fallback();});
 await page.goto('/');await type(page,'片栗粉のレシピを開いて');await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();await type(page,'新しいメニュー');await expect(page).toHaveURL('http://localhost:3100/');await type(page,'遅延パスタ、片栗粉10g');await expect(page.getByText('未保存の下書き：遅延パスタ')).toBeVisible();await type(page,'保存');await expect.poll(()=>payload).not.toBeNull();await page.goBack();await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();release();
 await expect(page.getByText('未保存の下書き：遅延パスタ')).toHaveCount(0);await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();expect(page.url()).toContain('/recipes/'+first);expect((await (await request.get('/api/recipes/'+payload.request_id)).json()).title.value).toBe('遅延パスタ');
});
