require('./ts-require.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {toSaveMaterials}=require('../app/VoiceRecipeRegistration.tsx');
const material={name:'パスタ',quantity:'100',unit:'g',price_jpy:'350',price_quantity:'500',price_unit:'g',supplier:' Amazon '};
test('approved projection preserves supplier and the complete purchase tuple',()=>{
 const [saved]=toSaveMaterials({materials:[material]});
 assert.deepEqual(saved,{name:'パスタ',quantity:'100',unit:'g',supplier:'Amazon',price_jpy:'350',price_quantity:'500',price_unit:'g'});
});
test('an incomplete purchase tuple remains unresolved without dropping the supplier',()=>{
 const [saved]=toSaveMaterials({materials:[{...material,price_quantity:''}]});
 assert.equal(saved.supplier,'Amazon');assert.equal(saved.quantity,'100');
 assert.equal(saved.price_jpy,null);assert.equal(saved.price_quantity,null);assert.equal(saved.price_unit,null);
});
test('unspecified supplier is sent as null for server-side abstract supplier resolution',()=>{
 const [saved]=toSaveMaterials({materials:[{...material,supplier:''}]});assert.equal(saved.supplier,null);assert.equal(saved.price_jpy,'350');
});
