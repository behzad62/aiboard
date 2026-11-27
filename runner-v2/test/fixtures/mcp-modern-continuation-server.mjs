import { createInterface } from "node:readline";
const io=createInterface({input:process.stdin});
const version="2026-07-28";
const stamp="2026-11-26T00:00:00Z";
const task={taskId:"native-task",createdAt:stamp,lastUpdatedAt:stamp,ttlMs:30000,pollIntervalMs:100};
const prompt={a:{method:"elicitation/create",params:{mode:"form",message:"Confirm label?",requestedSchema:{type:"object",properties:{label:{type:"string"}},required:["label"]}}}};
let stage=0;
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\n");
io.on("line",line=>{
  const m=JSON.parse(line),p=m.params;
  if(m.method==="server/discover") return reply(m.id,{supportedVersions:[version],capabilities:{tools:{}}});
  if(m.method==="tools/list") return reply(m.id,{tools:[{name:"lookup",_meta:{ui:{resourceUri:"ui://docs/dashboard.html"}},inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]});
  if(m.method==="tools/call" && stage===0){
    if(p.arguments.query!=="first")throw Error("wrong input");
    stage=1;return reply(m.id,{resultType:"input_required",inputRequests:prompt,requestState:"native-state"});
  }
  if(m.method==="tools/call" && stage===1){
    if(p.arguments.query!=="first"||p.requestState!=="native-state"||p.inputResponses.a.content.label!=="human")throw Error("wrong continuation");
    stage=2;return reply(m.id,{resultType:"task",...task,status:"working",content:[]});
  }
  if(m.method==="tasks/get" && stage===2){
    if(p.taskId!==task.taskId)throw Error("wrong task");
    stage=3;return reply(m.id,{resultType:"complete",...task,status:"input_required",inputRequests:prompt});
  }
  if(m.method==="tasks/update" && stage===3){
    if(p.taskId!==task.taskId||p.inputResponses.a.content.label!=="human")throw Error("wrong task input");
    stage=4;return reply(m.id,{resultType:"complete"});
  }
  if(m.method==="tasks/get" && stage===4){
    if(p.taskId!==task.taskId)throw Error("wrong task");
    stage=5;return reply(m.id,{resultType:"complete",...task,status:"completed",result:{content:[{type:"text",text:"continued:first"}],_meta:{appOnly:"private-ui-data"}}});
  }
  if(m.method==="resources/read" && stage===5){
    if(p.uri!=="ui://docs/dashboard.html")throw Error("wrong resource");
    return reply(m.id,{contents:[{uri:p.uri,mimeType:"text/html;profile=mcp-app",text:"<html><body>local app</body></html>"}]});
  }
  if(m.method==="tools/call" && stage===5 && p.arguments.query==="later")return reply(m.id,{resultType:"complete",content:[{type:"text",text:"found:later"}]});
  throw Error("unexpected request "+m.method+" stage "+stage);
});
