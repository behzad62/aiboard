import { durableStdioTasks } from "../src/mcp-task-recovery.js";
import assert from "node:assert/strict";
import test from "node:test";
import { McpStdioContinuation } from "../src/mcp-stdio-continuation.js";
import { createStreamingRequestOperation } from "../src/streaming-request-operation.js";
import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "../src/session-authority.js";

const meta={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{name:"test",version:"1"}};
const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
const req=(id:number,method:string,params:Record<string,unknown>)=>enc({jsonrpc:"2.0",id,method,params:{...params,_meta:meta}});
const result=(id:number,r:unknown)=>enc({jsonrpc:"2.0",id,result:r});
const initial={name:"lookup",arguments:{query:"original"}};
const prompts={a:{method:"elicitation/create",params:{mode:"form",message:"Confirm?",requestedSchema:{type:"object",properties:{answer:{type:"string"}}}}}};
const answers={a:{action:"accept",content:{answer:"yes"}}};
const stamp="2026-11-26T00:00:00Z";
const task={taskId:"task-one",createdAt:stamp,lastUpdatedAt:stamp,ttlMs:30000,pollIntervalMs:100};
const assertion:OperationAuthorizationAssertion={sessionId:"s",operation:"request",requestAccess:[],credentialNames:[],networkApproved:false,externalApproved:false,destructiveApproved:false,binding:{runId:"run",sessionId:"agent",actor:{role:"worker",id:"worker"},callId:"call",toolName:"mcp.docs.lookup",permissionProfile:"full"}};

test("wire gate requires correlated stdout and preserves the exact original call",()=>{
  const g=new McpStdioContinuation();
  assert.equal(g.begin(req(1,"tools/call",initial)),true);
  const next={...initial,inputResponses:answers,requestState:"opaque"};
  assert.equal(g.permit(req(2,"tools/call",next)),false);
  const response=result(1,{resultType:"input_required",inputRequests:prompts,requestState:"opaque"});
  g.feed(response.subarray(0,10));
  assert.equal(g.permit(req(2,"tools/call",next)),false);
  g.feed(response.subarray(10));
  for(const invalid of [
    req(2,"tools/call",{...next,name:"other"}),
    req(2,"tools/call",{...next,arguments:{query:"changed"}}),
    req(2,"tools/call",{...next,requestState:"foreign"}),
    req(2,"tools/call",{...next,inputResponses:{wrong:answers.a}}),
    req(2,"tools/call",{...next,inputResponses:{a:{action:"unknown"}}}),
    req(1,"tools/call",next),req(2,"resources/read",{uri:"file://x"}),
  ]) assert.equal(g.permit(invalid),false);
  assert.equal(g.permit(req(2,"tools/call",next)),true);
  assert.equal(g.permit(req(3,"tools/call",next)),false);
  g.feed(result(2,{resultType:"complete",content:[]}));
  assert.equal(g.permit(req(3,"tools/call",next)),false);
});
test("wire gate binds task polling, updates and cancellation to the returned task",()=>{
  const g=new McpStdioContinuation();
  g.begin(req(1,"tools/call",initial));
  g.feed(result(1,{resultType:"task",...task,status:"working",content:[]}));
  assert.equal(g.permit(req(2,"tasks/get",{taskId:"other"})),false);
  assert.equal(g.permit(req(2,"tasks/update",{taskId:task.taskId,inputResponses:answers})),false);
  assert.equal(g.permit(req(2,"tasks/get",{taskId:task.taskId})),true);
  g.feed(result(2,{...task,resultType:"complete",status:"input_required",inputRequests:prompts}));
  assert.equal(g.permit(req(3,"tasks/get",{taskId:task.taskId})),false);
  assert.equal(g.permit(req(3,"tasks/update",{taskId:"other",inputResponses:answers})),false);
  assert.equal(g.permit(req(3,"tasks/update",{taskId:task.taskId,inputResponses:answers})),true);
  g.feed(result(3,{resultType:"complete"}));
  assert.equal(g.permit(req(4,"tasks/cancel",{taskId:"other"})),false);
  assert.equal(g.permit(req(4,"tasks/cancel",{taskId:task.taskId})),true);
  g.feed(result(4,{resultType:"complete"}));
  assert.equal(g.permit(req(5,"tasks/get",{taskId:task.taskId})),false);
});
test("wrong IDs, errors and unrequested input methods never authorize another write",()=>{
  for(const reply of [result(99,{resultType:"task",...task}),enc({jsonrpc:"2.0",id:1,error:{code:-1,message:"failed"}}),result(1,{resultType:"input_required",inputRequests:{a:{method:"roots/list"}},requestState:"opaque"})]){
    const g=new McpStdioContinuation();g.begin(req(1,"tools/call",initial));g.feed(reply);
    assert.equal(g.permit(req(2,"tasks/get",{taskId:task.taskId})),false);
    assert.equal(g.permit(req(2,"tools/call",{...initial,inputResponses:answers,requestState:"opaque"})),false);
  }
});
test("streaming request fence observes stdout, not callback claims, and rechecks grant",async()=>{
  let current=true;
  let output:Buffer|undefined;
  const writes:Buffer[]=[];
  const operation=createStreamingRequestOperation({sessionId:"s",assert:()=>{if(!current)throw new Error("revoked");},
    write:async (bytes,_timeout,check)=>{check();writes.push(Buffer.from(bytes));},waitForOutput:async()=>true,
    deliver:async (_a,_e,deliver)=>{if(output)await deliver("stdout",output);return true;}});
  const auth={} as SessionOperationAuthorization;
  await operation(auth,assertion,async io=>{
    await io.write(req(1,"tools/call",initial),1000);
    const next=req(2,"tools/call",{...initial,inputResponses:answers,requestState:"opaque"});
    await assert.rejects(io.write(next,1000),/one request write/);
    output=result(1,{resultType:"input_required",inputRequests:prompts,requestState:"opaque"});
    await io.deliverOutput(async()=>undefined);
    current=false;
    await assert.rejects(io.write(next,1000),/revoked/);
    current=true;
    await io.write(next,1000);
    output=result(2,{resultType:"complete",content:[]});
    await io.deliverOutput(async()=>undefined);
    await assert.rejects(io.write(req(3,"tools/call",initial),1000),/one request write/);
  },1000);
  assert.equal(writes.length,2);
});

test("modern cancellation must match the exact pending request and metadata",()=>{
  const g=new McpStdioContinuation();g.begin(req(1,"tools/call",initial));
  const cancel=(id:number,m:unknown=meta)=>enc({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:id,reason:"Cancelled by caller",_meta:m}});
  assert.equal(g.cancellation(cancel(2)),false);
  assert.equal(g.cancellation(cancel(1,{})),false);
  assert.equal(g.cancellation(cancel(1)),true);
  assert.equal(g.cancellation(cancel(1)),false);
  g.feed(result(1,{resultType:"input_required",inputRequests:prompts,requestState:"opaque"}));
  assert.equal(g.permit(req(2,"tools/call",{...initial,inputResponses:answers,requestState:"opaque"})),false);
});
test("the continuation and task polling ceilings are independently enforced",()=>{
  const g=new McpStdioContinuation();g.begin(req(1,"tools/call",initial));
  for(let id=1;id<=8;id++){
    g.feed(result(id,{resultType:"input_required",inputRequests:prompts,requestState:"opaque"}));
    assert.equal(g.permit(req(id+1,"tools/call",{...initial,inputResponses:answers,requestState:"opaque"})),true);
  }
  g.feed(result(9,{resultType:"input_required",inputRequests:prompts,requestState:"opaque"}));
  assert.equal(g.permit(req(10,"tools/call",{...initial,inputResponses:answers,requestState:"opaque"})),false);
  const t=new McpStdioContinuation();t.begin(req(1,"tools/call",initial));
  t.feed(result(1,{resultType:"task",...task,status:"working",content:[]}));
  for(let id=2;id<242;id++){
    assert.equal(t.permit(req(id,"tasks/get",{taskId:task.taskId})),true);
    t.feed(result(id,{...task,resultType:"complete",status:"working"}));
  }
  assert.equal(t.permit(req(242,"tasks/get",{taskId:task.taskId})),false);
  assert.equal(t.permit(req(242,"tasks/cancel",{taskId:task.taskId})),true);
});

test("only a successful tool with a pinned app URI permits one resource read",()=>{
  const uri="ui://docs/dashboard.html";
  for(const [binding,reply] of [
    [undefined,{content:[]}],
    [{toolName:"other",uri},{content:[]}],
    [{toolName:"lookup",uri},{content:[],isError:true}],
    [{toolName:"lookup",uri},{content:[],resultType:"input_required"}],
  ] as const){
    const g=new McpStdioContinuation(binding);g.begin(req(1,"tools/call",initial));g.feed(result(1,reply));
    assert.equal(g.permit(req(2,"resources/read",{uri})),false);
  }
  const g=new McpStdioContinuation({toolName:"lookup",uri});g.begin(req(1,"tools/call",initial));
  assert.equal(g.permit(req(2,"resources/read",{uri})),false);
  g.feed(result(1,{resultType:"complete",content:[]}));
  assert.equal(g.permit(req(2,"resources/read",{uri:"ui://other/x"})),false);
  assert.equal(g.permit(req(2,"resources/read",{uri,other:true})),false);
  assert.equal(g.permit(req(2,"resources/read",{uri})),true);
  g.feed(result(2,{contents:[{uri,mimeType:"text/html;profile=mcp-app",text:"<b>ok</b>"}]}));
  assert.equal(g.permit(req(3,"resources/read",{uri})),false);
  assert.equal(g.permit(req(3,"tools/call",initial)),false);
});
test("successful task completion unlocks only the original pinned app resource",()=>{
  const uri="ui://docs/dashboard.html";
  const g=new McpStdioContinuation({toolName:"lookup",uri});g.begin(req(1,"tools/call",initial));
  g.feed(result(1,{resultType:"task",...task,status:"working",content:[]}));
  assert.equal(g.permit(req(2,"resources/read",{uri})),false);
  assert.equal(g.permit(req(2,"tasks/get",{taskId:task.taskId})),true);
  g.feed(result(2,{resultType:"complete",...task,status:"completed",result:{content:[]}}));
  assert.equal(g.permit(req(3,"resources/read",{uri})),true);
});

test("ordinary Tasks and malformed durability claims never opt into cross-process recovery",()=>{
  const d=(extensions:unknown)=>({capabilities:{extensions}});
  assert.equal(durableStdioTasks(d({"io.modelcontextprotocol/tasks":{}})),false);
  assert.equal(durableStdioTasks(d({"io.aiboard/durable-tasks":{crossProcess:true}})),false);
  assert.equal(durableStdioTasks(d({"io.modelcontextprotocol/tasks":{},"io.aiboard/durable-tasks":{crossProcess:"true"}})),false);
  assert.equal(durableStdioTasks(d({"io.modelcontextprotocol/tasks":{},"io.aiboard/durable-tasks":{crossProcess:false}})),false);
  assert.equal(durableStdioTasks(d({"io.modelcontextprotocol/tasks":{},"io.aiboard/durable-tasks":{crossProcess:true}})),true);
});

test("wire gate rejects reused task identity even if the opaque task ID matches",()=>{
  const uri="ui://test/view.html";
  for(const status of ["working","input_required","completed"] as const){
    const g=new McpStdioContinuation({toolName:"lookup",uri});
    assert.ok(g.begin(req(1,"tools/call",initial)));
    g.feed(result(1,{...task,resultType:"task",status:"working"}));
    assert.ok(g.permit(req(2,"tasks/get",{taskId:task.taskId})));
    g.feed(result(2,{...task,createdAt:"2026-11-26T01:00:00Z",lastUpdatedAt:"2026-11-26T01:00:00Z",resultType:"complete",status,
      ...(status==="input_required"?{inputRequests:prompts}:status==="completed"?{result:{content:[]}}:{})}));
    assert.equal(g.permit(req(3,"tasks/get",{taskId:task.taskId})),false);
    assert.equal(g.permit(req(3,"tasks/update",{taskId:task.taskId,inputResponses:answers})),false);
    assert.equal(g.permit(req(3,"tasks/cancel",{taskId:task.taskId})),false);
    assert.equal(g.permit(req(3,"resources/read",{uri})),false);
  }
});
