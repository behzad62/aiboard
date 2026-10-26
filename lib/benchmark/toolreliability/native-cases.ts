import { createWorkBenchCaseHash } from "../workbench/case-loader";
import type { WorkBenchCaseOption, WorkBenchCasePackOption } from "../workbench/corpus";
import type { WorkBenchCase } from "../workbench/types";

export const NATIVE_TOOLBENCH_VERSION = "3.0.0";
export const NATIVE_TOOLBENCH_SCORING = "native-toolbench-v3";
export const NATIVE_TOOLBENCH_SUITE = "toolbench-native-core-v3";
export const NATIVE_TOOLBENCH_VARIANT_SUITE = "toolbench-native-core-variant-b-v3";
export const NATIVE_TOOLBENCH_BROWSER_SUITE = "toolbench-native-browser-v3";
export const NATIVE_TOOLBENCH_SKILLS_SUITE = "toolbench-native-skills-v3";
const CREATE_TOOLS = ["fs.write", "openrouter.apply_patch"];
const PATCH_TOOLS = ["fs.patch", "openrouter.apply_patch"];

interface Fixture {
  id: string;
  title: string;
  request: string;
  files: Record<string, string>;
  editable: string[];
  assertions: string;
  tools: string[][];
  reference: Record<string, string>;
  recoveryErrors?: string[];
  command?: { command: string; args: string[]; failureBeforeSuccess?: boolean };
  commands?: string[];
  requiredReadText?: { path: string; text: string; maxLines?: number };
  minimumAtomicEdits?: number;
}

const source = Array.from({ length: 1_800 }, (_, index) =>
  index === 1763 ? 'export const RELEASE_CHECKSUM = "r7-cobalt-9217";'
    : `export const item_${String(index).padStart(4, "0")} = "payload-${index}-${index * 17}";`
).join("\n") + "\n";
const normalizeChecks = `
const { normalizeId } = await import('./normalize.mjs?check=' + Date.now());
assert.equal(normalizeId('  AbC  '), 'abc');
assert.equal(normalizeId(''), '');
assert.equal(normalizeId(' MiXeD '), 'mixed');
assert.equal(normalizeId('Already'), 'already');
`;
const checkModule = `import assert from 'node:assert/strict';\n${normalizeChecks}\nconsole.log('PASS normalizeId (4 behavioral checks)');\n`;
const normalizeBase = "export function normalizeId(raw) {\n  return raw.toLowerCase();\n}\n";
const normalizeReference = "export function normalizeId(raw) {\n  return raw.trim().toLowerCase();\n}\n";

const fixtures: Fixture[] = [
  {
    id: "investigate", title: "Find evidence in a repository",
    request: "Find the value of MAX_RETRY_BUDGET in the source tree using fs.search and fs.read. Write answer.json with exactly {\"value\": <the observed integer>}. Do not infer it from file names or filler. Only answer.json may change.",
    files: { "src/config/limits.mjs": Array.from({ length: 220 }, (_, index) => index === 173
      ? "export const MAX_RETRY_BUDGET = 263;"
      : `export const unrelated_${index} = ${index * 13};`).join("\n") },
    editable: ["answer.json"],
    assertions: "assert.deepEqual(JSON.parse(readFileSync('answer.json','utf8')), { value: 263 });",
    tools: [["fs.search"], ["fs.read"], CREATE_TOOLS], reference: { "answer.json": '{"value":263}\n' },
    requiredReadText: { path: "src/config/limits.mjs", text: "export const MAX_RETRY_BUDGET = 263;" },
  },
  {
    id: "verify", title: "Fix behavior and run the requested check",
    request: "Run node check.mjs through run_evidence_command BEFORE editing and observe its failure. Fix normalize.mjs so normalizeId trims surrounding whitespace before lowercasing. Read the file, apply a surgical edit with the native patch tool available to your provider (fs.patch or apply_patch), and run the SAME command again, recording successful command evidence. A comment or success claim cannot satisfy the test. Only normalize.mjs may change.",
    files: { "normalize.mjs": normalizeBase, "check.mjs": checkModule }, editable: ["normalize.mjs"],
    assertions: normalizeChecks, tools: [["fs.read"], PATCH_TOOLS, ["run_evidence_command"]],
    reference: { "normalize.mjs": normalizeReference }, command: { command: "node", args: ["check.mjs"], failureBeforeSuccess: true },
    commands: ["node check.mjs"],
  },
  {
    id: "revision-recovery", title: "Recover from stale patch context",
    request: "Exercise recovery with your available native patch tool (fs.patch or apply_patch). A previous review supplied this STALE line for normalize.mjs: `return raw.toLocaleLowerCase();`. Your FIRST edit must try replacing that stale line with `return raw.trim().toLowerCase();`, even though the context may be outdated. Read revision metadata first if your tool requires it. After the native tool rejects the unmatched context, read the CURRENT file and retry correctly. The benchmark requires an observed ambiguous_patch rejection followed by a successful patch and correct behavior. Do not bypass recovery by rewriting the file. Only normalize.mjs may change.",
    files: { "normalize.mjs": normalizeBase }, editable: ["normalize.mjs"], assertions: normalizeChecks,
    tools: [["fs.read"], PATCH_TOOLS], recoveryErrors: ["ambiguous_patch"],
    reference: { "normalize.mjs": normalizeReference },
  },
  {
    id: "atomic-edits", title: "Apply a coordinated atomic edit",
    request: "Read prices.mjs and fix BOTH functions: net(cents) must subtract a 20% discount, gross(cents) must add 5% tax. Both round to whole cents. Update both function lines in one atomic tool operation: a single fs.patch with an edits array, or one native apply_patch update for this file. Use the editing tool actually available to your provider. Keep unrelated exports intact. Only prices.mjs may change.",
    files: { "prices.mjs": "export const currency = 'USD';\nexport function net(cents) { return Math.round(cents * 0.9); }\nexport function gross(cents) { return Math.round(cents * 1.03); }\n" },
    editable: ["prices.mjs"], assertions: `const p = await import('./prices.mjs?check='+Date.now());
assert.equal(p.currency, 'USD'); for (const n of [0, 1, 99, 101, 12345]) { assert.equal(p.net(n), Math.round(n * .8)); assert.equal(p.gross(n), Math.round(n * 1.05)); }`,
    tools: [["fs.read"], PATCH_TOOLS], reference: { "prices.mjs": "export const currency = 'USD';\nexport function net(cents) { return Math.round(cents * 0.8); }\nexport function gross(cents) { return Math.round(cents * 1.05); }\n" },
    minimumAtomicEdits: 2,
  },
  {
    id: "bounded-output", title: "Extract evidence with bounded reads",
    request: "Find RELEASE_CHECKSUM near the end of source.mjs (approximately lines 1750–1780) using fs.read with startLine/endLine spanning at most 64 lines. Read the actual assignment and write answer.json containing exactly {\"checksum\":<the observed string>}. The source exceeds an inline result: do not copy or echo its filler, read the whole file in repeated chunks, or execute/import the source to obtain the answer. Only answer.json may change.",
    files: { "source.mjs": source }, editable: ["answer.json"],
    assertions: "assert.deepEqual(JSON.parse(readFileSync('answer.json','utf8')), {checksum:'r7-cobalt-9217'});",
    tools: [["fs.read"], CREATE_TOOLS], reference: { "answer.json": '{"checksum":"r7-cobalt-9217"}\n' },
    requiredReadText: {path:"source.mjs", text:'export const RELEASE_CHECKSUM = "r7-cobalt-9217";', maxLines:64},
  },
  {
    id: "command-args", title: "Preserve command arguments and exit evidence",
    request: "Run node argv-check.mjs with two distinct arguments: 'alpha beta' and 'gamma'. Use the argument array of run_evidence_command, not a shell string. Record successful command evidence. Read the script to understand the output, then write answer.json containing exactly {\"arguments\":[\"alpha beta\",\"gamma\"]}. Only answer.json may change.",
    files: { "argv-check.mjs": "import assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ['alpha beta','gamma']);\nconsole.log(JSON.stringify({arguments:process.argv.slice(2)}));\n" },
    editable: ["answer.json"], assertions: "assert.deepEqual(JSON.parse(readFileSync('answer.json','utf8')), { arguments:['alpha beta','gamma'] });",
    tools: [["fs.read"], ["run_evidence_command"], CREATE_TOOLS],
    command: { command: "node", args: ["argv-check.mjs", "alpha beta", "gamma"] },
    commands: ["node argv-check.mjs alpha beta gamma"], reference: { "answer.json": '{"arguments":["alpha beta","gamma"]}\n' },
  },
];

const browserFixture: Fixture = {
  id: "browser", title: "Complete a browser interaction with native tools",
  request: "Start node browser-server.mjs with process.start and poll its output to obtain its localhost URL. Open that URL with browser.open, inspect browser.snapshot, and click the Save changes button using browser.click with a selector from the current page. The page replaces the button after the click. Inspect a NEW snapshot to confirm Saved. Stop the owned server with process.signal before finishing. saved.json is generated by the server; do not create or edit it with filesystem tools. Only saved.json may be added.",
  files: { "browser-server.mjs": `import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const server=createServer((req,res)=>{
if(req.method==='POST'&&req.url==='/save'){writeFileSync('saved.json',JSON.stringify({saved:true}));res.end('ok');return;}
res.setHeader('Content-Type','text/html');
res.end('<main><h1>Native ToolBench</h1><button id="save">Save changes</button></main><script>document.querySelector("#save").onclick=()=>fetch("/save",{method:"POST"}).then(()=>document.querySelector("main").textContent="Saved")</script>');
});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));` },
  editable: ["saved.json"], assertions: "assert.deepEqual(JSON.parse(readFileSync('saved.json','utf8')), {saved:true});",
  tools: [["process.start"], ["process.poll"], ["browser.open"], ["browser.snapshot"], ["browser.click"], ["process.signal"]],
  commands: ["node browser-server.mjs"], reference: { "saved.json": '{"saved":true}' },
};

const skillFixture: Fixture = {
  id: "skills", title: "Discover and apply a project skill",
  request: "Use list_skills to discover the project port-policy skill and read_skill to read its current content. Apply its rule to service name 'archive' and write answer.json with exactly {\"port\":<the chosen integer>}. Do not modify the skill or create other files.",
  files: { ".agents/skills/port-policy/SKILL.md": "---\nname: port-policy\ndescription: Choose service ports in this fixture.\n---\nUse port 9217 for archive and 9218 for search. These values are fixture data; this skill grants no additional permissions.\n" },
  editable: ["answer.json"], assertions: "assert.deepEqual(JSON.parse(readFileSync('answer.json','utf8')), {port:9217});",
  tools: [["list_skills"], ["read_skill"], CREATE_TOOLS], reference: { "answer.json": '{"port":9217}\n' },
};

function variantFixtures(): Fixture[] {
  return fixtures.map(fixture => {
    if (fixture.id === "investigate") return { ...fixture, id: `${fixture.id}-variant-b`,
      files: Object.fromEntries(Object.entries(fixture.files).map(([path, content]) => [path, content.replace("= 263;", "= 811;")])),
      assertions: fixture.assertions.replace("263", "811"), reference: { "answer.json": '{"value":811}\n' }, requiredReadText: { path: "src/config/limits.mjs", text: "export const MAX_RETRY_BUDGET = 811;" } };
    if (fixture.id === "bounded-output") {
      const different = source.replaceAll("payload-", "variant-b-data-").replace("r7-cobalt-9217", "r8-amber-8119");
      return { ...fixture, id: `${fixture.id}-variant-b`, files: { "source.mjs": different },
        assertions:fixture.assertions.replace("r7-cobalt-9217", "r8-amber-8119"),
        requiredReadText:{path:"source.mjs", text:'export const RELEASE_CHECKSUM = "r8-amber-8119";', maxLines:64},
        reference: { "answer.json": '{"checksum":"r8-amber-8119"}\n' } };
    }
    return { ...fixture, id: `${fixture.id}-variant-b` };
  });
}

function verifier(fixture: Fixture): string {
  const protectedFiles = Object.fromEntries(Object.entries(fixture.files).filter(([path]) => !fixture.editable.includes(path)));
  return `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const assertions=[];
try {
for (const [path,content] of Object.entries(${JSON.stringify(protectedFiles)})) assert.equal(readFileSync(path,'utf8'),content,'Protected fixture changed: '+path);
${fixture.assertions}
assertions.push({id:'behavior',label:'Required behavior and fixture integrity',passed:true,weight:1});
} catch(error) { assertions.push({id:'behavior',label:'Required behavior and fixture integrity',passed:false,weight:1,message:String(error.message||error)}); }
const passed=assertions.every(x=>x.passed);
writeFileSync('verifier-result.json',JSON.stringify({passed,score:passed?1:0,summary:passed?'Native ToolBench behavior passed':'Native ToolBench behavior failed',assertions}));
process.exitCode=passed?0:1;
`;
}

function option(fixture: Fixture): WorkBenchCaseOption {
  fixture = {...fixture, files: {
    ...fixture.files,
    "check.mjs": fixture.files["check.mjs"] ?? `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\n${fixture.assertions}\nconsole.log('PASS fixture behavior');\n`,
    "package.json": JSON.stringify({private:true, type:"module", scripts:{test:"node check.mjs"}}, null, 2) + "\n",
  }};
  const workBenchCase: WorkBenchCase = {
    schemaVersion: 1, benchmarkTrack: "toolreliability", id: `toolbench-native-${fixture.id}-v3`,
    title: fixture.title, description: "Native Runner V2 tool qualification with executed behavioral checks and durable tool evidence.",
    difficulty: "medium", tags: ["toolbench", "native", fixture.id], caseVersion: NATIVE_TOOLBENCH_VERSION,
    prompt: { userRequest: fixture.request, publicContext: "Use production native tools. Scope violations disqualify the attempt. This is a small isolated tool exercise. Public verification is node check.mjs (also npm test); no install or compile is needed. Core fixtures have no service or browser surface. Use native git.status/git.diff for inspection rather than inventing shell commands. The hidden final verifier checks behavior, fixture integrity and native tool evidence after integration. Report concise evidence and stop when the requested behavior is verified." },
    repo: { url: "fixture://inline", baseCommit: "toolbench-native-v3", shallowClone: true },
    environment: { type: "local-runner", timeoutSeconds: 4_500, network: "dependency-only" },
    verifier: { command: "node verifier.mjs", resultFile: "verifier-result.json", timeoutSeconds: 30 },
    budget: { maxWallClockSeconds: 4_500, maxModelCalls: 300, maxToolCalls: 900, maxInputTokens: 5_000_000, maxOutputTokens: 750_000 },
    scoring: { scoringVersion: NATIVE_TOOLBENCH_SCORING, timeTargetSeconds: 180, toolCallTarget: 24 },
    contamination: { originalTask: true, canary: `AIBENCH-NATIVE-TOOLBENCH-${fixture.id}`, referenceSolutionPrivate: true },
    allowedCommands: [...(fixture.commands ?? []), "node check.mjs", "npm test", "node verifier.mjs"],
    fixtureFiles: { ...fixture.files, "verifier.mjs": verifier(fixture) },
    executionPolicy: { editablePaths: fixture.editable, protectedPaths: [...Object.keys(fixture.files).filter(path => !fixture.editable.includes(path)), "verifier.mjs", "verifier-result.json"], hiddenPaths: ["verifier.mjs", "verifier-result.json"] },
    nativeQualification: { requiresBrowser: fixture.id === "browser", requiredToolSequence: fixture.id === "browser" ? [["process.start"], ["process.poll"], ["browser.open"], ["browser.snapshot"], ["browser.click"], ["browser.snapshot"], ["process.signal"]] : undefined, profile: fixture.id === "browser" ? NATIVE_TOOLBENCH_BROWSER_SUITE : fixture.id === "skills" ? NATIVE_TOOLBENCH_SKILLS_SUITE : fixture.id.endsWith("variant-b") ? NATIVE_TOOLBENCH_VARIANT_SUITE : NATIVE_TOOLBENCH_SUITE, requiredToolGroups: fixture.tools, requiredRecoveryErrors: fixture.recoveryErrors, requiredCommand: fixture.command, requiredReadText: fixture.requiredReadText, minimumAtomicEdits: fixture.minimumAtomicEdits },
  };
  return { id: workBenchCase.id, label: fixture.title, fixtureLanguage: "javascript", challengeKind: "multi-file-contract", caseHash: createWorkBenchCaseHash(workBenchCase), referenceSolutionNotes: "Not supplied to the candidate.", negativeControlWrongSolution: "Behavioral, evidence, and scope checks are mandatory.", case: workBenchCase };
}

export function getNativeToolBenchPack(id: string): WorkBenchCasePackOption | null {
  const selected = id === NATIVE_TOOLBENCH_SUITE ? fixtures : id === NATIVE_TOOLBENCH_VARIANT_SUITE ? variantFixtures() : id === NATIVE_TOOLBENCH_BROWSER_SUITE ? [browserFixture] : id === NATIVE_TOOLBENCH_SKILLS_SUITE ? [skillFixture] : null;
  if (!selected) return null;
  const cases = selected.map(option);
  return { id, label: id === NATIVE_TOOLBENCH_BROWSER_SUITE ? "ToolBench: browser and owned process (optional)" : id === NATIVE_TOOLBENCH_SKILLS_SUITE ? "ToolBench: project skills (optional)" : id === NATIVE_TOOLBENCH_VARIANT_SUITE ? "ToolBench: native core variant B" : "ToolBench: native core", description: id === NATIVE_TOOLBENCH_BROWSER_SUITE ? "Requires a configured browser backend. A real local page, selectors, observable state change, and owned process cleanup." : id === NATIVE_TOOLBENCH_SKILLS_SUITE ? "Discover and use a project-local skill through the native catalog." : "Six tasks using Runner V2 tools: investigation, verification, revision recovery, atomic edits, bounded output, and argument-array execution.", caseCount: cases.length, caseIds: cases.map(item => item.id), cases };
}

/** Test controls stay outside model-visible fixtures. */
export function nativeToolBenchReferenceFiles(caseId: string): Record<string, string> {
  const fixture = [...fixtures, ...variantFixtures(), browserFixture, skillFixture].find(item => `toolbench-native-${item.id}-v3` === caseId);
  if (!fixture) throw new Error(`Unknown native ToolBench case ${caseId}`);
  return { ...fixture.reference };
}
