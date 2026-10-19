import assert from 'node:assert/strict';
import { streamOpenAICompatibleChat } from '../lib/providers/openai-compat';
import { streamOpenAIResponses } from '../lib/providers/openai';
import { streamMetaResponses } from '../lib/providers/meta';
import { streamXAIResponses } from '../lib/providers/xai';
import { streamAnthropicWithClient } from '../lib/providers/anthropic';
import { streamGoogleGenerateContent } from '../lib/providers/google';
import { resolveModelCallUsage } from '../lib/client/token-usage';
import type { ChatParams, StreamChunk } from '../lib/providers/base';

const params: ChatParams={model:'test-model',apiKey:'fixture',messages:[{role:'user',content:'Hello'}],maxTokens:100,temperature:1};
async function* events(items: unknown[]) { for (const item of items) yield item; }
async function usage(stream: AsyncIterable<StreamChunk>) {
 const chunks=await Array.fromAsync(stream);
 assert.equal(chunks.find(c=>c.type==='error'),undefined,JSON.stringify(chunks));
 const reportedUsage=chunks.find(c=>c.type==='usage')?.usage;
 const resolved=resolveModelCallUsage({messages:params.messages,output:'short',maxTokens:100,reportedUsage});
 assert.equal(resolved.usageSource,'reported');
 return resolved;
}
for(const provider of ['openai','openrouter','deepseek','nvidia','custom','meta','xai']){
 let body: Record<string,unknown>={};
 const client={chat:{completions:{create:async(input:Record<string,unknown>)=>{body=input;return events([
  {choices:[{delta:{content:'OK'}}]},
  {choices:[],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140,prompt_cache_hit_tokens:30,
   completion_tokens_details:{reasoning_tokens:10}}},
 ]);}}}};
 const result=await usage(streamOpenAICompatibleChat(client as never,params,provider,provider));
 assert.equal(result.inputTokens,100);assert.equal(result.outputTokens,40);assert.equal(result.cachedInputTokens,30);
 if(['openai','openrouter','deepseek'].includes(provider))assert.deepEqual(body.stream_options,{include_usage:true});
}
for(const stream of [streamOpenAIResponses,streamMetaResponses,streamXAIResponses]){
 const client={responses:{create:async()=>events([{type:'response.completed',response:{status:'completed',usage:{input_tokens:100,output_tokens:40,total_tokens:140,input_tokens_details:{cached_tokens:30},output_tokens_details:{reasoning_tokens:10}}}}])}};
 const result=await usage(stream(client as never,params));
 assert.equal(result.cachedInputTokens,30);assert.equal(result.reasoningTokens,10);
}
for(const provider of ['anthropic','foundry']){
 const client={messages:{stream:async()=>events([
  {type:'message_start',message:{usage:{input_tokens:60,cache_read_input_tokens:30,cache_creation_input_tokens:10,output_tokens:1}}},
  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:40}},
 ])}};
 const result=await usage(streamAnthropicWithClient(client as never,params,provider,provider));
 assert.equal(result.inputTokens,100);assert.equal(result.outputTokens,40);assert.equal(result.cacheWriteInputTokens,10);
}
const google={models:{generateContentStream:async()=>events([
 {text:'OK',usageMetadata:{promptTokenCount:90,candidatesTokenCount:20}},
 {usageMetadata:{toolUsePromptTokenCount:10,thoughtsTokenCount:20,totalTokenCount:140,cachedContentTokenCount:30}},
])}};
const g=await usage(streamGoogleGenerateContent(google as never,params));
assert.equal(g.inputTokens,100);assert.equal(g.outputTokens,40);assert.equal(g.totalTokens,140);assert.equal(g.reasoningTokens,20);
console.log('PASS provider-reported usage across browser transports, final usage-only chunks, cache/reasoning and Gemini tool-prompt accounting');
