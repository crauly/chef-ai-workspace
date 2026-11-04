require('./ts-require.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {describe}=require('../app/AIEditor.tsx');
const {editVoiceCommand,voiceCommand}=require('../app/voice-commands.ts');
const recipe={title:{value:'料理'},selling_price_jpy:{value:'1000'},materials:[{id:'a',material_name:{value:'卵'},quantity:{value:'10'},unit:'g',price_mode:'override'}]};
test('edit consent is standalone and scoped to editing',()=>{
 for(const text of ['承認','更新して','更新してください','変更案を承認します','保存して'])assert.equal(editVoiceCommand(text),'save');
 for(const text of ['承認しない','更新しないでください'])assert.equal(editVoiceCommand(text),'hold');
 for(const text of ['卵を追加して更新して','承認という名前','承認していいですか'])assert.equal(editVoiceCommand(text),'data');
 assert.equal(voiceCommand('承認'),'data');
});
test('sequential changes project additions, replacement and removal without mutating saved data',()=>{
 const ops=[{op:'set_material_name',material_id:'a',value:'牛乳'},{op:'set_material_quantity',material_id:'a',value:'20',unit:'g'},{op:'add_material',material_id:'b',name:'塩',quantity:'1',unit:'g',price_jpy:'100',price_quantity:'100',price_unit:'g'},{op:'remove_material',material_id:'a'}];
 const result=describe(recipe,ops,'ja');assert.match(result.changes[0],/卵 → 牛乳/);assert.match(result.changes[3],/削除: 牛乳/);assert.deepEqual(result.materials.map(m=>m.id),['b']);assert.ok(result.addedIds.has('b'));assert.equal(recipe.materials[0].material_name.value,'卵');
 assert.equal(describe(recipe,[{op:'remove_material',material_id:'missing'}],'ja'),null);
});
