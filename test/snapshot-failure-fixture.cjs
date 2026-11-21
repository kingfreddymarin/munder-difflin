// Executes the production snapshot failure read and conditional DTO projection.
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
module.exports=function snapshotFailure(value){
 const source=fs.readFileSync(path.join(__dirname,'../src/main/index.ts'),'utf8');
 const tree=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
 const declarations=[];let projection;
 function visit(node){
  if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>['orchestratorFailure','hasOrchestratorFailure'].includes(d.name.getText(tree))))declarations.push(node.getText(tree));
  if(ts.isSpreadAssignment(node)&&node.getText(tree).includes('hasOrchestratorFailure ?'))projection=node.getText(tree);
  ts.forEachChild(node,visit);
 }visit(tree);
 if(declarations.length!==2||!projection)throw new Error('Snapshot failure read/projection is missing');
 let reads=0;const stages=[];
 const code=ts.transpileModule(`(()=>{${declarations.join('\n')}return {${projection}};})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const result=vm.runInNewContext(code,{time:(stage,work)=>{stages.push(stage);return work();},orchestratorStart:{failure:()=>{reads++;return value;}}});
 return {result,reads,stages};
};
