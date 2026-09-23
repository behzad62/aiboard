/** Qualification-only source material faults. No variant selector enters the guest. */
const wrapper=(s,body)=>s+`\n{const original=createService;globalThis.createService=async(p,g)=>{const service=await original(p,g);${body};return service;};}\n`;
export const sourceControls={
 'misreport-source-prefix':{description:'Report one extra byte of unavailable source prefix in the public evidence while keeping the real durable prefix and suffix history unchanged.',mutate:s=>wrapper(s,"const run=service.run.bind(service);service.run=async q=>{const r=await run(q);if(q.type==='readEvidence'&&r.kind==='ok')r.value.manifest.totals.stdout.sourcePrefix++;return r;}")},
};
export function sourceMaterialControl(v){const n=v.id.slice('B17/source-'.length),a=v.args;
 if(n==='legacy-evidence')return 'ignore-legacy-gap';if(n==='legacy-terminal-identity')return 'optimistic-reconciliation';
 if(n==='format-allowed-extension')return 'reject-allowed-extension';
 if(n==='missing-old'||n.startsWith('format-')&&n!=='format-valid')return 'optimistic-restore';
 if(n.startsWith('proof-')&&a.claim!=='stale'||n.startsWith('pending-ack')||n.startsWith('unknown-ack')||n.startsWith('lost-receipt')||n.startsWith('observation-response')||n==='consumer-unknown'||n.startsWith('takeover-')||n.startsWith('at-deadline')||n.startsWith('after-deadline'))return 'optimistic-reconciliation';
 return 'misreport-source-prefix';
}
export function sourceExpectedAssertion(v){const n=v.id.slice('B17/source-'.length);
 if(n==='legacy-evidence')return 'restore must progress';if(n==='legacy-terminal-identity')return 'restore must refuse';
 if(n==='format-allowed-extension')return 'restore must progress';if(n==='missing-old'||n.startsWith('format-')&&n!=='format-valid')return 'restore must refuse';
 if(n.startsWith('proof-')&&v.args.claim!=='stale')return 'source refusal has exact permitted category';
 if(n.startsWith('pending-ack')||n.startsWith('unknown-ack'))return 'source ACK obligation retains exact state and ID';
 if(n.startsWith('lost-receipt')||n.startsWith('observation-response'))return 'lost source response retains unknown operation';
 if(n==='consumer-unknown')return 'stop must refuse';
 if(n.startsWith('takeover-'))return 'old source operation cannot publish after takeover';
 if(n.startsWith('at-deadline')||n.startsWith('after-deadline'))return 'original source request does not succeed at/after deadline';
 return 'source accounting stdout preserves exact prefix and actual suffix';
}
