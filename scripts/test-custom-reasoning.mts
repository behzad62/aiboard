import assert from "node:assert/strict";
import type OpenAI from "openai";
import {streamOpenAICompatibleChat} from "../lib/providers/openai-compat";
import {streamOpenAIResponses} from "../lib/providers/openai";
import {supportedBenchmarkReasoningEfforts} from "../lib/benchmark/model-effort";
import type {ChatParams} from "../lib/providers/base";
import { addCustomModel, updateUserSettings, __clearClientStoreForTests, __resetClientStoreForTests } from "../lib/client/store";
import { createNativeProviderConfig } from "../lib/client/native-build-engine";

function params(effort:ChatParams["reasoningEffort"]):ChatParams {
 return {apiKey:"none",model:"mule-mimo-q4",messages:[{role:"user",content:"Hello"}],reasoningEffort:effort};
}

async function collect(asyncIt:AsyncIterable<unknown>){
 for await(const x of asyncIt){void x;}
}
for(const effort of ["default","none","low","medium","high"] as const){
 const chatRequests:Array<Record<string,unknown>>=[];
 const responseRequests:Array<Record<string,unknown>>=[];
 const fake={
  baseURL:"http://localhost:11434/v1",
  chat:{completions:{create:async (payload:Record<string,unknown>)=>{
    chatRequests.push(payload);
    return (async function*(){yield {choices:[{delta:{content:"ready"},finish_reason:"stop"}]};})();
  }}},
  responses:{create:async (payload:Record<string,unknown>)=>{
    responseRequests.push(payload);
    return (async function*(){yield {type:"response.output_text.delta",delta:"ready"};yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};})();
  }}
 } as unknown as OpenAI;
 await collect(streamOpenAICompatibleChat(fake,params(effort),"custom","test","max_tokens"));
 await collect(streamOpenAIResponses(fake,params(effort),"custom"));
 assert.equal(chatRequests.length,1);
 assert.equal(responseRequests.length,1);
 assert.equal(chatRequests[0].reasoning_effort,effort==="default"?undefined:effort);
 const reason=responseRequests[0].reasoning as {effort?:string}|undefined;
 assert.equal(reason?.effort,effort==="default"?undefined:effort);
}
const available=supportedBenchmarkReasoningEfforts({providerId:"custom",modelId:"custom:sample"});
assert.deepEqual(available,["default","none","low","medium","high"]);
__resetClientStoreForTests();
addCustomModel({ id: "local-reasoning", label: "Local", model: "local-model", baseURL: "http://localhost:11434/v1", apiKey: "", hasKey: false,
 reasoningEffort: "none", capabilities: { image: false, document: false, audio: false, video: false } });
updateUserSettings({ modelContextOverrides: { "custom:local-reasoning": { contextWindowTokens: 65_536, maxOutputTokens: 32_768 } } });
const nativeDefault = createNativeProviderConfig("custom:local-reasoning", 0);
assert.equal(nativeDefault.reasoningEffort, "none", "saved Off reaches the native adapter");
assert.equal(nativeDefault.maxOutputTokens, 32_768);
assert.equal(nativeDefault.contextWindowTokens, 65_536);
assert.equal(createNativeProviderConfig("custom:local-reasoning", 0, "high").reasoningEffort, "high");
assert.equal(createNativeProviderConfig("custom:local-reasoning", 0, "none").reasoningEffort, "none");
assert.equal(createNativeProviderConfig("custom:local-reasoning", 0, "default").reasoningEffort, "none");
__clearClientStoreForTests();
console.log("PASS custom providers preserve explicit reasoning effort for Chat Completions and Responses, while default omits it; ToolBench exposes selectable effort.");
