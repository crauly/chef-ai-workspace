import {test,expect} from "@playwright/test";
const seed="11111111-1111-4111-8111-111111111111";

test("fixture formal registration creates a distinct recipe and keeps seeded data unchanged",async({request})=>{
 await request.post("http://127.0.0.1:8100/test/reset");
 const id="88888888-8888-4888-8888-888888888888";
 const input={request_id:id,title:"じゃがいものピュレ",selling_price_jpy:null,
  materials:[{name:"じゃがいも",quantity:"200",unit:"g",price_jpy:null,price_quantity:null,price_unit:null},
   {name:"塩",quantity:null,unit:null,price_jpy:null,price_quantity:null,price_unit:null}]};
 const first=await request.post("/api/recipes/full",{data:input,headers:{Origin:"http://localhost:3100"}});
 expect(first.status()).toBe(201);
 const result=await first.json();
 expect(result.id).toBe(id);
 expect(result.title.value).toBe(input.title);
 expect(result.materials.map((m:{material_name:{value:string}})=>m.material_name.value)).toEqual(["じゃがいも","塩"]);
 expect(result.materials[1].quantity.value).toBeNull();
 const retry=await request.post("/api/recipes/full",{data:input,headers:{Origin:"http://localhost:3100"}});
 expect(retry.ok()).toBe(true);
 expect((await retry.json()).id).toBe(id);
 const detail=await request.get("/api/recipes/"+id);
 expect((await detail.json()).title.value).toBe(input.title);
 const original=await request.get("/api/recipes/"+seed);
 expect((await original.json()).title.value).toBe("片栗粉のレシピ");
 const list=await request.get("/api/recipes");
 const titles=(await list.json()).items.map((entry:{title:string})=>entry.title);
 expect(titles).toContain(input.title);
 expect(titles).toContain("片栗粉のレシピ");
});
