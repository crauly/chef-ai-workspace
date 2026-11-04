// Lightweight Node tests execute TS modules without starting Playwright, a browser,
// a server, or a model. Full type safety is checked separately by tsc.
const ts = require('typescript');
const fs = require('node:fs');
for (const ext of ['.ts', '.tsx']) {
  require.extensions[ext] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true}, fileName: filename,
  }).outputText, filename);
}
