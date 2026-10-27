import assert from "node:assert/strict";
import test from "node:test";
import type { NativeTool } from "../src/agent-contracts.js";
import { runAgentLoop } from "../src/agent-loop.js";
import { ManagedBuildToolRuntime, withManagedBuildToolLifecycle } from "../src/managed-build-tools.js";
import { ToolBroker } from "../src/tool-broker.js";

const options = { permissionProfile:"full" as const, workspacePath:process.cwd() };
const context = {runId:"build",sessionId:"worker",actor:{role:"worker" as const,id:"worker"}};
const tool = (name:string, execute:()=>Promise<void>, readOnly=true):NativeTool<unknown> => ({
  definition:{name,description:name,inputSchema:{type:"object"},readOnly,effect:readOnly?"none":"external"},
  validate:input=>({ok:true,value:input}),
  execute:async()=>{await execute();return {isError:false,content:[]};},
});

test("managed generations change only after pending calls settle and preserve the role filter", async()=>{
  let generation=0; let calls=0;
  const closed:number[]=[];
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const base=new ToolBroker(options);
  base.register(tool("native.read",async()=>undefined));
  const runtime=new ManagedBuildToolRuntime(base,{generation:async()=>generation,tools:async g=>({
    tools:g ? [tool("mcp.test.read",async()=>{calls++;await pending;}),tool("mcp.test.write",async()=>undefined,false)] : [],
    close:async()=>{closed.push(g);},
  })},options,t=>t.definition.readOnly===true);
  await runtime.prepare();
  generation=1;await runtime.prepare();await runtime.prepare();
  assert.deepEqual(closed,[0]);
  assert.deepEqual(runtime.definitions().map(t=>t.name),["native.read","mcp.test.read"]);
  const invoking=runtime.invoke({type:"tool_call",callId:"once",name:"mcp.test.read",arguments:{}},context);
  generation=2;
  await assert.rejects(runtime.prepare(),/in flight/);
  release();assert.equal((await invoking).isError,false);
  await runtime.prepare();
  assert.equal(calls,1,"the original call was never replayed across a generation change");
  await runtime.close();
  assert.deepEqual(closed,[0,1,2]);
});

test("failed refresh never calls the model and disposes a conflicting candidate", async()=>{
  let closed=0;let modelCalls=0;
  const base=new ToolBroker(options);base.register(tool("native.read",async()=>undefined));
  const runtime=new ManagedBuildToolRuntime(base,{generation:async()=>1,tools:async()=>({tools:[tool("native.read",async()=>undefined)],close:async()=>{closed++;}})},options,()=>true);
  const result=await runAgentLoop({model:{complete:async()=>{modelCalls++;throw new Error("must not call");}},registry:runtime,beforeModelTurn:()=>runtime.prepare(),context,initialMessages:[]});
  assert.equal(result.status,"suspended");
  if(result.status!=="suspended")throw new Error("Expected suspension");
  assert.equal(result.errorCode,"capability_refresh_failed");
  assert.equal(closed,1);assert.equal(modelCalls,0);
});

test("a primary agent failure and failed managed cleanup are both preserved", async()=>{
  const primary=new Error("primary");const cleanup=new Error("cleanup");
  const runtime=new ManagedBuildToolRuntime(new ToolBroker(options),{generation:async()=>1,tools:async()=>({tools:[],close:async()=>{throw cleanup;}})},options,()=>true);
  await assert.rejects(withManagedBuildToolLifecycle(runtime,async()=>{throw primary;}),error=>error instanceof AggregateError && error.errors[0]===primary && error.errors[1]===cleanup);
});
