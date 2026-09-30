// Deliberately incorrect result neighbors for real categorical predicates.
// They run the original service first, so actual corruption/authority facts,
// receipt reconciliation and durable state remain visible in the trusted trace.
export const categoryNeighborIds = ['A04/primary', 'A07/invalid-stream', 'A07/invalid-digest', 'A07/invalid-artifactId', 'A07/invalid-channelId'];
export const authorityNeighborIds = ['A01/primary', 'A01/takeover-before', 'A01/takeover-after'];
export function forbiddenCategory(source, code) {
 if(!['backend','input'].includes(code))throw Error('unknown forbidden category');
 return source+`\n{const original=globalThis.createService;globalThis.createService=async(p,g)=>{const service=await original(p,g),run=service.run.bind(service);service.run=async q=>{const result=await run(q);if(['restore','poll'].includes(q.type)&&result.kind==='blocked')for(const blocker of result.blockers)if(['integrity','gap'].includes(blocker.code))blocker.code='${code}';return result;};return service;};}\n`;
}
export function forbiddenAuthority(source) {
 return source+`\n{const original=globalThis.createService;globalThis.createService=async(p,g)=>{const service=await original(p,g),run=service.run.bind(service);service.run=async q=>{const result=await run(q);if(q.type==='stop'&&result.kind==='stale')return {kind:'blocked',blockers:[{code:'cleanup',jobId:q.jobId}],failures:[]};return result;};return service;};}\n`;
}
