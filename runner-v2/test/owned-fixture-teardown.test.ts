import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import assert from "node:assert/strict";
import test from "node:test";
import { finishOwnedFixture } from "./support/owned-fixture-teardown.js";
for (const failedOwner of [undefined, "server", "supervisor", "manager", "factory", "host"]) test("owned fixture preserves closer order and removal eligibility: " + failedOwner, async () => {
 const order: string[] = []; const sentinel = new Error("owner");
 const operation = finishOwnedFixture({ bodyFailed: false, closers: ["server","supervisor","manager","factory","host"].map(name=>({name,close:()=>{order.push(name);if(name===failedOwner)throw sentinel;}})),remove:()=>{order.push("remove");} });
 if(failedOwner)await assert.rejects(operation,e=>e===sentinel);else await operation;
 assert.deepEqual(order,failedOwner?["server","supervisor","manager","factory","host"]:["server","supervisor","manager","factory","host","remove"]);
});
test("owned fixture preserves body and every closer/report error identity",async()=>{
 const body=new Error("body"),first=new Error("first"),later=new Error("later"),report=new Error("report");let facts:unknown;
 await assert.rejects(finishOwnedFixture({bodyFailed:true,bodyError:body,closers:[{name:"first",close:async()=>{throw first;}},{name:"later",close:()=>{throw later;}}],remove:()=>assert.fail("unverified owner"),report:failures=>{facts=failures.map(f=>f.error);throw report;}}),e=>e instanceof AggregateError&&e.errors[0]===body&&e.errors[1]===first&&e.errors[2]===later&&e.errors[3]===report);assert.deepEqual(facts,[body,first,later]);
});
test("owned fixture sole throw undefined and removal error remain exact",async()=>{
 let failed=false,removed=false;try{await finishOwnedFixture({bodyFailed:true,bodyError:undefined,closers:[],remove:()=>{removed=true;}});}catch(e){failed=true;assert.equal(e,undefined);}assert.ok(failed&&removed);
 const sentinel=new Error("remove");await assert.rejects(finishOwnedFixture({bodyFailed:false,closers:[],remove:()=>{throw sentinel;}}),e=>e===sentinel);
});

test("actual planning finally retains body/owner errors and attempts all original closers", async () => {
 const url = new URL("../../tests/e2e/runner-v2-t8-planning-journey.spec.ts", import.meta.url);
 const source = ts.createSourceFile("ui.ts",readFileSync(url,"utf8"),ts.ScriptTarget.Latest,true);let finalText="";
 function walk(node: ts.Node) { if(ts.isTryStatement(node)&&node.finallyBlock?.getText(source).includes("finishOwnedFixture")) finalText=node.finallyBlock.getText(source);ts.forEachChild(node,walk); }
 walk(source);assert.ok(finalText);
 for(const failedOwner of ["manager","supervisor"]) {
  const order:string[]=[];const body=new Error("body"),failure=new Error("owner");let caught:unknown;
  const context={bodyFailed:true,bodyError:body,root:"inert",finishOwnedFixture,browserHttp:undefined,emitBrowserDiagnostic:()=>undefined,page:{close:async()=>{order.push("page");}},server:{close:async()=>{order.push("server");}},supervisor:{close:()=>{order.push("supervisor");if(failedOwner==="supervisor")throw failure;}},manager:{close:async()=>{order.push("manager");if(failedOwner==="manager")throw failure;}},factory:{close:async()=>{order.push("factory");}},executionHost:{close:async()=>{order.push("host");}},rmSync:()=>order.push("remove"),console:{error(){},dir(){}}};
  try{await runInNewContext("(async()=> "+finalText+")()",context);}catch(e){caught=e;}
  assert.ok(caught instanceof AggregateError);assert.deepEqual(caught.errors,[body,failure]);assert.deepEqual(order,["page","server","supervisor","manager","factory","host"]);
 }
});
