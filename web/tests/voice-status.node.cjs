require('./ts-require.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {VoiceProcessingPanel}=require('../app/VoiceProcessingStatus.tsx');
const render=(rows,locale='ja')=>renderToStaticMarkup(React.createElement(VoiceProcessingPanel,{locale,rows}));
test('no work renders no floating surface',()=>assert.equal(render([]),''));
test('all real simultaneous stages fit one accessible panel without truncating the list',()=>{
 const output=render(['listen','transcribe','intent','parse','price','propose','save'].map(key=>({key})));
 assert.equal((output.match(/role="status"/g)||[]).length,1);
 for(const text of ['音声受付中','文字起こし中','指示を確認中','レシピ解析中','価格検索中','変更案を作成中','レシピ保存中'])assert.ok(output.includes(text));
 assert.equal((output.match(/data-stage=/g)||[]).length,7);
});
test('failed stages stop progress animation and English uses the same display contract',()=>{
 const failure=render([{key:'price',error:true}]);assert.ok(failure.includes('価格検索に失敗'));
 assert.ok(!failure.includes('animate-pulse'));
 const retry=render([{key:'price'}],'en-US');assert.ok(retry.includes('Searching prices'));assert.ok(retry.includes('data-state="active"'));
});
