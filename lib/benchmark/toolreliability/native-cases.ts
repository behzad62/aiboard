import { createWorkBenchCaseHash } from "../workbench/case-loader";
import type { WorkBenchCaseOption, WorkBenchCasePackOption } from "../workbench/corpus";
import type { WorkBenchCase } from "../workbench/types";

export const NATIVE_TOOLBENCH_VERSION = "4.0.1";
export const NATIVE_TOOLBENCH_SCORING = "solo-toolbench-v4.1";
export const LEGACY_NATIVE_TOOLBENCH_SUITE = "toolbench-native-core-v4";
/** Lean capability qualification used by the Run tab. Legacy suite identities remain readable for historical evidence. */
export const NATIVE_TOOLBENCH_SUITE = "toolbench-native-capability-v6";
export const NATIVE_TOOLBENCH_CAPABILITY_VERSION = "6.2.0";
export const NATIVE_TOOLBENCH_CAPABILITY_SCORING = "solo-toolbench-capability-v6.2";
export const NATIVE_TOOLBENCH_VARIANT_SUITE = "toolbench-native-core-variant-b-v4";
export const NATIVE_TOOLBENCH_BROWSER_SUITE = "toolbench-native-browser-v4";
export const NATIVE_TOOLBENCH_SKILLS_SUITE = "toolbench-native-skills-v4";
/** v5 adds cases for the newer native tools; v4 case identities are unchanged so old evidence still replays. */
export const NATIVE_TOOLBENCH_EXTENDED_VERSION = "5.0.0";
export const NATIVE_TOOLBENCH_EXTENDED_SCORING = "solo-toolbench-v5.0";
export const NATIVE_TOOLBENCH_EXTENDED_SUITE = "toolbench-native-extended-v5";
export const NATIVE_TOOLBENCH_BROWSER_FORM_SUITE = "toolbench-native-browser-form-v5";
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
  /** v5 only: identity, profile and the additional qualification it measures. */
  v6?: boolean;
  v5?: {
    profile: string;
    sequence?: string[][];
    qualification?: Pick<NonNullable<WorkBenchCase["nativeQualification"]>, "requiredContinuedSearchText" | "requiredArtifactText" | "requiresSkills" | "processGeneratedOutputs" | "requiresBrowser">;
    coverage: string[];
  };
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

const INCIDENT_ID = "inc-89fea6fda378";
const ledger = Object.fromEntries(Array.from({ length: 30 }, (_, part) => [
  `ledger/part-${String(part).padStart(2, "0")}.mjs`,
  Array.from({ length: 10 }, (_, entry) => {
    const id = `L${String(part).padStart(2, "0")}-${String(entry).padStart(2, "0")}`;
    return part === 27 && entry === 4 ? `// LEDGER_ENTRY id=${id} amount=-1250` : `// LEDGER_ENTRY id=${id} amount=+${(part * 37 + entry * 11) % 900 + 100}`;
  }).join("\n") + "\nexport {};\n",
]));

const extendedFixtures: Fixture[] = [
  {
    id: "code-navigation", title: "Navigate definitions and callers, then fix the definition",
    request: "Find where applyDiscount is defined and every module that calls it. All callers pass percent as a whole number (20 means 20%), but the definition treats it as a fraction. Fix the definition only, with your native patch tool (fs.patch or apply_patch). Then write callers.json containing exactly the sorted list of caller file paths relative to the project root, e.g. [\"src/a.mjs\"]. A module that merely defines a similarly named function is not a caller. Do not change the callers or src/pricing/legacy.mjs. Only src/pricing/discount.mjs and callers.json may change.",
    files: {
      "src/pricing/discount.mjs": "/** Applies a percentage discount to an amount in cents. */\nexport function applyDiscount(cents, percent) {\n  return Math.round(cents * (1 - percent));\n}\n",
      "src/pricing/legacy.mjs": "/** Deprecated: kept for old exports. Not used by the app. */\nexport function applyDiscountLegacy(cents, rate) {\n  return Math.round(cents - cents * rate);\n}\n",
      "src/cart.mjs": "import { applyDiscount } from './pricing/discount.mjs';\nexport function cartTotal(cents) {\n  return applyDiscount(cents, 20);\n}\n",
      "src/invoice/render.mjs": "import { applyDiscount } from '../pricing/discount.mjs';\nexport function renderInvoice(cents, percent) {\n  return `Total: ${applyDiscount(cents, percent)}`;\n}\n",
      "src/reports/summary.mjs": "export function summary(lines) {\n  return lines.join('\\n');\n}\n",
    },
    editable: ["src/pricing/discount.mjs", "callers.json"],
    assertions: `const cart = await import('./src/cart.mjs?check='+Date.now()); const invoice = await import('./src/invoice/render.mjs?check='+Date.now());
assert.equal(cart.cartTotal(1000), 800); assert.equal(invoice.renderInvoice(5000, 10), 'Total: 4500'); assert.equal(invoice.renderInvoice(999, 0), 'Total: 999');
assert.deepEqual(JSON.parse(readFileSync('callers.json','utf8')), ['src/cart.mjs','src/invoice/render.mjs']);`,
    tools: [["fs.search", "code.references", "code.workspace_symbols", "code.definition"], ["fs.read"], PATCH_TOOLS, CREATE_TOOLS],
    reference: { "src/pricing/discount.mjs": "/** Applies a percentage discount to an amount in cents. */\nexport function applyDiscount(cents, percent) {\n  return Math.round(cents * (1 - percent / 100));\n}\n", "callers.json": '["src/cart.mjs","src/invoice/render.mjs"]\n' },
    requiredReadText: { path: "src/pricing/discount.mjs", text: "export function applyDiscount(cents, percent)" },
    v5: { profile: NATIVE_TOOLBENCH_EXTENDED_SUITE, coverage: ["repository_search", "code_navigation", "file_read", "patch_edit", "file_create"] },
  },
  {
    id: "continued-search", title: "Continue a paged search to a late target",
    request: "Use fs.search on the ledger folder with the literal pattern LEDGER_ENTRY, no regex and the default page size (do not set maxMatches). Results arrive in pages: pass the returned cursor (with the same path and pattern) to get each next page until you find the single entry whose amount is negative. Do not narrow the pattern to the answer and do not read the ledger files one by one. Write answer.json with exactly {\"id\":\"<that entry's id>\"}. Only answer.json may change.",
    files: ledger, editable: ["answer.json"],
    assertions: "assert.deepEqual(JSON.parse(readFileSync('answer.json','utf8')), { id: 'L27-04' });",
    tools: [["fs.search"], CREATE_TOOLS], reference: { "answer.json": '{"id":"L27-04"}\n' },
    v5: { profile: NATIVE_TOOLBENCH_EXTENDED_SUITE, qualification: { requiredContinuedSearchText: "id=L27-04 amount=-1250" }, coverage: ["repository_search", "search_continuation", "file_create"] },
  },
  {
    id: "artifact-retrieval", title: "Retrieve a fact beyond the inline output bound",
    request: "Run node emit-report.mjs with run_evidence_command. Its output is far larger than an inline tool result, and only the tail is shown inline. Find the INCIDENT_ID value in the full stdout by reading the stdout artifact with artifact.read (page with offset and maxBytes; do not re-read a range you already read). The value is computed at run time, so reading the script does not reveal it. Write answer.json with exactly {\"incidentId\":\"<the value>\"}. Do not modify or re-implement the script. Only answer.json may change.",
    files: { "emit-report.mjs": `import { createHash } from 'node:crypto';
const id = 'inc-' + createHash('sha256').update('toolbench-incident-seed-5').digest('hex').slice(0, 12);
const lines = [];
for (let i = 1; i <= 1800; i++) {
  const n = String(i).padStart(5, '0');
  lines.push(i === 1100 ? \`line \${n} INCIDENT_ID=\${id} severity=high\` : \`line \${n} status=ok shard=\${(i * 7) % 97} checksum=\${((i * 2654435761) % 4294967296).toString(16).padStart(8, '0')}\`);
}
process.stdout.write(lines.join('\\n') + '\\n');
` },
    editable: ["answer.json"],
    assertions: `assert.deepEqual(JSON.parse(readFileSync('answer.json','utf8')), { incidentId: '${INCIDENT_ID}' });`,
    tools: [["run_evidence_command"], ["artifact.read"], CREATE_TOOLS],
    command: { command: "node", args: ["emit-report.mjs"] }, commands: ["node emit-report.mjs"],
    reference: { "answer.json": `{"incidentId":"${INCIDENT_ID}"}\n` },
    v5: { profile: NATIVE_TOOLBENCH_EXTENDED_SUITE, qualification: { requiredArtifactText: { text: `INCIDENT_ID=${INCIDENT_ID}` } }, coverage: ["evidence_command", "artifact_retrieval", "file_create"] },
  },
  {
    id: "interactive-process", title: "Answer an interactive process and read its output incrementally",
    request: "Start node quiz.mjs with process.start and interactive: true. Read its output with process.read_output to learn the access code (it changes on every run). Send the code as exactly one line with process.write_stdin, then close its input (closeInput). Read the output again, passing the cursor from your previous read, to confirm ACCEPTED and BYE; the program exits by itself after its input closes. If the outcome of a write is unclear, retry only with the same writeId. session.json is written by the program; do not create or edit it with filesystem tools.",
    files: { "quiz.mjs": `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const code = 'K' + randomBytes(3).toString('hex').toUpperCase();
const received = [];
console.log(\`READY: type the access code \${code} on one line, then close input.\`);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => { received.push(line); console.log(line.trim() === code ? 'ACCEPTED' : 'REJECTED'); });
lines.on('close', () => { writeFileSync('session.json', JSON.stringify({ expected: code, received, eof: true })); console.log('BYE'); });
` },
    editable: ["session.json"],
    assertions: "const session = JSON.parse(readFileSync('session.json','utf8')); assert.equal(session.eof, true); assert.deepEqual(session.received, [session.expected], 'exactly one delivered line: the code');",
    tools: [["process.start"], ["process.read_output"], ["process.write_stdin"]],
    commands: ["node quiz.mjs"], reference: {},
    v5: { profile: NATIVE_TOOLBENCH_EXTENDED_SUITE, sequence: [["process.start"], ["process.read_output"], ["process.write_stdin"], ["process.read_output"]], qualification: { processGeneratedOutputs: true }, coverage: ["process_interactive_input", "process_incremental_output", "process_cleanup"] },
  },
  {
    ...skillFixture, id: "project-skill",
    v5: { profile: NATIVE_TOOLBENCH_EXTENDED_SUITE, qualification: { requiresSkills: true }, coverage: ["project_skills", "file_create"] },
  },
];

const browserFormFixture: Fixture = {
  id: "browser-form", title: "Fill and submit a form in a real browser",
  request: "Start node form-server.mjs with process.start and read its output (process.read_output or process.poll) to obtain its localhost URL. Open it with browser.open and inspect browser.snapshot. Fill the Name field with Ada Lovelace and the Team field with Analytical Engines using browser.fill, then click Submit with browser.click. Inspect a NEW snapshot to confirm the page shows the saved values. Stop the owned server with process.signal before finishing. submission.json is written by the server; do not create or edit it with filesystem tools.",
  files: { "form-server.mjs": `import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const page = '<main><h1>Team sign-up</h1><form id="signup"><label>Name <input id="name" name="name"></label><label>Team <input id="team" name="team"></label><button id="submit" type="submit">Submit</button></form></main><script>document.querySelector("#signup").onsubmit=(e)=>{e.preventDefault();const body=JSON.stringify({name:document.querySelector("#name").value,team:document.querySelector("#team").value});fetch("/submit",{method:"POST",body}).then(r=>r.json()).then(v=>{document.querySelector("main").textContent="Saved: "+v.name+" / "+v.team})}</script>';
const server=createServer((req,res)=>{
if(req.method==='POST'&&req.url==='/submit'){let data='';req.on('data',c=>data+=c);req.on('end',()=>{const v=JSON.parse(data);writeFileSync('submission.json',JSON.stringify({name:v.name,team:v.team}));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));});return;}
res.setHeader('Content-Type','text/html');res.end(page);
});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));` },
  editable: ["submission.json"], assertions: "assert.deepEqual(JSON.parse(readFileSync('submission.json','utf8')), {name:'Ada Lovelace',team:'Analytical Engines'});",
  tools: [["process.start"], ["process.poll", "process.read_output"], ["browser.open"], ["browser.snapshot"], ["browser.fill"], ["browser.click"], ["process.signal"]],
  commands: ["node form-server.mjs"], reference: { "submission.json": '{"name":"Ada Lovelace","team":"Analytical Engines"}' },
  v5: { profile: NATIVE_TOOLBENCH_BROWSER_FORM_SUITE, sequence: [["process.start"], ["process.poll", "process.read_output"], ["browser.open"], ["browser.snapshot"], ["browser.fill"], ["browser.click"], ["browser.snapshot"], ["process.signal"]], qualification: { requiresBrowser: true, processGeneratedOutputs: true }, coverage: ["browser_interaction", "browser_form", "process_cleanup"] },
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

const V5_PUBLIC_CONTEXT = "Use production native tools directly as the only model. Scope violations disqualify the attempt. Public verification is node check.mjs (also npm test); no install or compile is needed. Use the tools the request names; tool errors are ordinary feedback. Finish with finish_toolbench when the requested task is complete. External hidden scoring runs only after your session ends; it checks saved behavior, fixture integrity, and recorded tool actions. No planning, review, documentation, integration or project handoff is required.";

/** One compact ToolBench profile: the existing process case also exercises browser automation. */
function capabilityFixtures(): Fixture[] {
  const navigation = extendedFixtures[0]!;
  const navigationBase = navigation.files["src/pricing/discount.mjs"]!;
  const navigationFixture: Fixture = {
    ...navigation,
    title: "Navigate callers and atomically repair two functions",
    request: "Find the definitions and all actual caller paths for applyDiscount and applyTax. Both functions receive percent as a whole number (20 means 20%). Read the current definition file, then fix BOTH functions in src/pricing/discount.mjs using one atomic native patch tool operation (fs.patch edits array or a single native apply_patch update). Do not change the callers or legacy exports. Write callers.json as an object with sorted applyDiscount and applyTax caller arrays. Only src/pricing/discount.mjs and callers.json may change.",
    files: {
      ...navigation.files,
      "src/pricing/discount.mjs": navigationBase + "export function applyTax(cents, percent) {\n  return Math.round(cents * (1 + percent));\n}\n",
      "src/invoice/render.mjs": "import { applyDiscount, applyTax } from '../pricing/discount.mjs';\nexport function renderInvoice(cents, percent) {\n  return `Total: ${applyTax(applyDiscount(cents, percent), 5)}`;\n}\n",
    },
    assertions: `const p = await import('./src/pricing/discount.mjs?check='+Date.now());
const cart = await import('./src/cart.mjs?check='+Date.now());
const invoice = await import('./src/invoice/render.mjs?check='+Date.now());
assert.equal(cart.cartTotal(1000), 800);
assert.equal(p.applyDiscount(5000, 10), 4500);
assert.equal(p.applyTax(1000, 5), 1050);
assert.equal(p.applyTax(101, 5), Math.round(101 * 1.05));
assert.equal(invoice.renderInvoice(5000, 10), 'Total: 4725');
assert.deepEqual(JSON.parse(readFileSync('callers.json','utf8')), {applyDiscount:['src/cart.mjs','src/invoice/render.mjs'],applyTax:['src/invoice/render.mjs']});`,
    reference: {
      "src/pricing/discount.mjs": navigation.reference["src/pricing/discount.mjs"]! + "export function applyTax(cents, percent) {\n  return Math.round(cents * (1 + percent / 100));\n}\n",
      "callers.json": '{"applyDiscount":["src/cart.mjs","src/invoice/render.mjs"],"applyTax":["src/invoice/render.mjs"]}\n',
    },
    minimumAtomicEdits: 2,
  };
  const report = extendedFixtures[2]!;
  const reportFixture: Fixture = {
    ...report,
    title: "Retrieve bounded file and command output evidence",
    request: "Run node emit-report.mjs through run_evidence_command with exactly two separate argv entries after the script: 'alpha beta' and 'gamma' (preserve the space in the first argument). The command emits a large report: use artifact.read with advancing offset and maxBytes (never repeat an offset) to observe INCIDENT_ID. Also use fs.read with startLine/endLine covering no more than 64 lines near 1750–1780 in source.mjs, observe RELEASE_CHECKSUM in the actual file; do not read the entire file or import it. Write answer.json containing exactly the observed incidentId and checksum. Only answer.json may change.",
    files: {
      ...report.files,
      "emit-report.mjs": "import assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ['alpha beta', 'gamma']);\n" + report.files["emit-report.mjs"]!,
      "source.mjs": source,
    },
    assertions: `assert.deepEqual(JSON.parse(readFileSync('answer.json','utf8')), {incidentId:'${INCIDENT_ID}',checksum:'r7-cobalt-9217'});`,
    reference: { "answer.json": `{"incidentId":"${INCIDENT_ID}","checksum":"r7-cobalt-9217"}\n` },
    tools: [[ "run_evidence_command" ], [ "artifact.read" ], [ "fs.read" ], CREATE_TOOLS],
    command: { command: "node", args: ["emit-report.mjs", "alpha beta", "gamma"] },
    commands: ["node emit-report.mjs alpha beta gamma"],
    requiredReadText: { path: "source.mjs", text: 'export const RELEASE_CHECKSUM = "r7-cobalt-9217";', maxLines: 64 },
  };
  const processFixture = extendedFixtures[3]!;
  const browserProcessFixture: Fixture = {
    ...processFixture,
    title: "Control an interactive process and its browser form",
    request: "Start node quiz.mjs with process.start and interactive: true. Read output with process.read_output to discover the runtime access code and local server URL. Open the URL with browser.open and inspect browser.snapshot. Use browser.fill to enter Ada Lovelace in Name and Analytical Engines in Team, submit with browser.click, and inspect a NEW snapshot to confirm the saved values. Next send the runtime access code exactly once with process.write_stdin and closeInput, then use process.read_output with its previous cursor to confirm ACCEPTED and BYE. If a write response is uncertain, retry using the SAME writeId. Finally stop the still-running owned server with process.signal. The process must generate submission.json and session.json; do not create either using filesystem tools.",
    files: {
      ...processFixture.files,
      "quiz.mjs": processFixture.files["quiz.mjs"]! + "\n" + browserFormFixture.files["form-server.mjs"]!.replace("import {writeFileSync} from 'node:fs';\n", ""),
    },
    editable: ["session.json", "submission.json"],
    assertions: processFixture.assertions + "\nassert.deepEqual(JSON.parse(readFileSync('submission.json','utf8')), {name:'Ada Lovelace',team:'Analytical Engines'});",
    tools: [
      ...processFixture.tools,
      ["browser.open"], ["browser.snapshot"], ["browser.fill"], ["browser.click"], ["process.signal"],
    ],
    v5: {
      profile: NATIVE_TOOLBENCH_SUITE,
      sequence: [
        ["process.start"], ["process.read_output"], ["browser.open"], ["browser.snapshot"],
        ["browser.fill"], ["browser.click"], ["browser.snapshot"],
        ["process.write_stdin"], ["process.read_output"], ["process.signal"],
      ],
      qualification: { requiresBrowser: true, processGeneratedOutputs: true },
      coverage: [...processFixture.v5!.coverage, "browser_interaction", "browser_form"],
    },
  };
  const selected = [fixtures[1]!, fixtures[2]!, navigationFixture, extendedFixtures[1]!, reportFixture, browserProcessFixture, extendedFixtures[4]!];
  return selected.map((fixture): Fixture => ({
    ...fixture,
    v6: true,
    v5: {
      profile: NATIVE_TOOLBENCH_SUITE,
      coverage: fixture.id === "code-navigation"
        ? [...fixture.v5!.coverage, "atomic_multi_edit"]
        : fixture.id === "artifact-retrieval"
          ? [...fixture.v5!.coverage, "file_read", "bounded_file_read", "command_arguments"]
          : fixture.v5?.coverage ?? (fixture.id === "verify"
        ? ["file_read", "patch_edit", "evidence_command"]
        : ["file_read", "patch_edit", "patch_recovery"]),
      ...(fixture.v5?.qualification ? { qualification: fixture.v5.qualification } : {}),
      ...(fixture.v5?.sequence ? { sequence: fixture.v5.sequence } : {}),
    },
  }));
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

function caseIdOf(fixture: Fixture): string {
  return `toolbench-native-${fixture.id}-${fixture.v6 ? "v6" : fixture.v5 ? "v5" : "v4"}`;
}

function option(fixture: Fixture): WorkBenchCaseOption {
  fixture = {...fixture, files: {
    ...fixture.files,
    "check.mjs": fixture.files["check.mjs"] ?? `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\n${fixture.assertions}\nconsole.log('PASS fixture behavior');\n`,
    "package.json": JSON.stringify({private:true, type:"module", scripts:{test:"node check.mjs"}}, null, 2) + "\n",
  }};
  const workBenchCase: WorkBenchCase = {
    schemaVersion: 1, benchmarkTrack: "toolreliability", id: caseIdOf(fixture),
    title: fixture.title, description: "Native Runner V2 tool qualification with executed behavioral checks and durable tool evidence.",
    difficulty: "medium", tags: ["toolbench", "native", fixture.id], caseVersion: fixture.v6 ? NATIVE_TOOLBENCH_CAPABILITY_VERSION : fixture.v5 ? NATIVE_TOOLBENCH_EXTENDED_VERSION : NATIVE_TOOLBENCH_VERSION,
    prompt: { userRequest: fixture.request, publicContext: fixture.v5 ? V5_PUBLIC_CONTEXT : "Use production native tools directly as the only model. Scope violations disqualify the attempt. Public verification is node check.mjs (also npm test); no install or compile is needed. Core fixtures have no service or browser surface. Use fs.search/fs.read for inspection rather than inventing shell commands. Finish with finish_toolbench when the requested task is complete. External hidden scoring runs only after your session ends; it checks saved behavior, fixture integrity, and recorded tool actions. No planning, review, documentation, integration or project handoff is required." },
    repo: { url: "fixture://inline", baseCommit: fixture.v6 ? "toolbench-native-v6" : fixture.v5 ? "toolbench-native-v5" : "toolbench-native-v4", shallowClone: true },
    environment: { type: "local-runner", timeoutSeconds: fixture.v6 ? 300 : 4_500, network: "dependency-only" },
    verifier: { command: "node verifier.mjs", resultFile: "verifier-result.json", timeoutSeconds: 30 },
    budget: fixture.v6
      ? { maxWallClockSeconds: 300, maxModelCalls: fixture.id === "interactive-process" ? 36 : 24, maxToolCalls: fixture.id === "interactive-process" ? 96 : 64, maxInputTokens: 120_000, maxOutputTokens: 24_000 }
      : { maxWallClockSeconds: 4_500, maxModelCalls: 300, maxToolCalls: 900, maxInputTokens: 5_000_000, maxOutputTokens: 750_000 },
    scoring: { scoringVersion: fixture.v6 ? NATIVE_TOOLBENCH_CAPABILITY_SCORING : fixture.v5 ? NATIVE_TOOLBENCH_EXTENDED_SCORING : NATIVE_TOOLBENCH_SCORING, timeTargetSeconds: 180, toolCallTarget: 24 },
    contamination: { originalTask: true, canary: `AIBENCH-NATIVE-TOOLBENCH-${fixture.id}`, referenceSolutionPrivate: true },
    allowedCommands: [...(fixture.commands ?? []), "node check.mjs", "npm test", "node verifier.mjs"],
    fixtureFiles: { ...fixture.files, "verifier.mjs": verifier(fixture) },
    executionPolicy: { editablePaths: fixture.editable, protectedPaths: [...Object.keys(fixture.files).filter(path => !fixture.editable.includes(path)), "verifier.mjs", "verifier-result.json"], hiddenPaths: ["verifier.mjs", "verifier-result.json"] },
    nativeQualification: fixture.v5 ? {
      profile: fixture.v5.profile, requiredToolGroups: fixture.tools, ...(fixture.v5.sequence ? { requiredToolSequence: fixture.v5.sequence } : {}),
      ...(fixture.recoveryErrors ? { requiredRecoveryErrors: fixture.recoveryErrors } : {}), ...(fixture.command ? { requiredCommand: fixture.command } : {}),
      ...(fixture.requiredReadText ? { requiredReadText: fixture.requiredReadText } : {}), ...(fixture.minimumAtomicEdits ? { minimumAtomicEdits: fixture.minimumAtomicEdits } : {}),
      ...fixture.v5.qualification, coverage: fixture.v5.coverage,
    } : { requiresBrowser: fixture.id === "browser", requiredToolSequence: fixture.id === "browser" ? [["process.start"], ["process.poll"], ["browser.open"], ["browser.snapshot"], ["browser.click"], ["browser.snapshot"], ["process.signal"]] : undefined, profile: fixture.id === "browser" ? NATIVE_TOOLBENCH_BROWSER_SUITE : fixture.id === "skills" ? NATIVE_TOOLBENCH_SKILLS_SUITE : fixture.id.endsWith("variant-b") ? NATIVE_TOOLBENCH_VARIANT_SUITE : LEGACY_NATIVE_TOOLBENCH_SUITE, requiredToolGroups: fixture.tools, requiredRecoveryErrors: fixture.recoveryErrors, requiredCommand: fixture.command, requiredReadText: fixture.requiredReadText, minimumAtomicEdits: fixture.minimumAtomicEdits },
  };
  return { id: workBenchCase.id, label: fixture.title, fixtureLanguage: "javascript", challengeKind: "multi-file-contract", caseHash: createWorkBenchCaseHash(workBenchCase), referenceSolutionNotes: "Not supplied to the candidate.", negativeControlWrongSolution: "Behavioral, evidence, and scope checks are mandatory.", case: workBenchCase };
}

export function getNativeToolBenchPack(id: string): WorkBenchCasePackOption | null {
  if (id === NATIVE_TOOLBENCH_SUITE) {
    const cases = capabilityFixtures().map(option);
    return {
      id,
      label: "ToolBench: capability check",
      description: "One seven-case tool qualification including editing/recovery, search, command artifacts, project skills and a combined browser + interactive process workflow.",
      caseCount: cases.length, caseIds: cases.map(item => item.id), cases,
    };
  }
  if (id === NATIVE_TOOLBENCH_EXTENDED_SUITE || id === NATIVE_TOOLBENCH_BROWSER_FORM_SUITE) {
    const cases = (id === NATIVE_TOOLBENCH_EXTENDED_SUITE ? extendedFixtures : [browserFormFixture]).map(option);
    return id === NATIVE_TOOLBENCH_EXTENDED_SUITE
      ? { id, label: "ToolBench: native tools extended", description: "Five tasks for newer native tools: definition/caller navigation, paged search continuation, artifact retrieval beyond the inline bound, an interactive process with incremental output, and a project skill. Results are scoped to these capabilities.", caseCount: cases.length, caseIds: cases.map(item => item.id), cases }
      : { id, label: "ToolBench: browser form (optional)", description: "Requires a configured browser backend. Fill and submit a real form on an owned local server, confirm the persisted result, and clean up the server.", caseCount: cases.length, caseIds: cases.map(item => item.id), cases };
  }
  const selected = id === LEGACY_NATIVE_TOOLBENCH_SUITE ? fixtures : id === NATIVE_TOOLBENCH_VARIANT_SUITE ? variantFixtures() : id === NATIVE_TOOLBENCH_BROWSER_SUITE ? [browserFixture] : id === NATIVE_TOOLBENCH_SKILLS_SUITE ? [skillFixture] : null;
  if (!selected) return null;
  const cases = selected.map(option);
  return { id, label: id === NATIVE_TOOLBENCH_BROWSER_SUITE ? "ToolBench: browser and owned process (optional)" : id === NATIVE_TOOLBENCH_SKILLS_SUITE ? "ToolBench: project skills (optional)" : id === NATIVE_TOOLBENCH_VARIANT_SUITE ? "ToolBench: native core variant B" : "ToolBench: native core", description: id === NATIVE_TOOLBENCH_BROWSER_SUITE ? "Requires a configured browser backend. A real local page, selectors, observable state change, and owned process cleanup." : id === NATIVE_TOOLBENCH_SKILLS_SUITE ? "Discover and use a project-local skill through the native catalog." : "Six tasks using Runner V2 tools: investigation, verification, revision recovery, atomic edits, bounded output, and argument-array execution.", caseCount: cases.length, caseIds: cases.map(item => item.id), cases };
}

/** Test controls stay outside model-visible fixtures. */
export function nativeToolBenchReferenceFiles(caseId: string): Record<string, string> {
  const fixture = [...fixtures, ...variantFixtures(), browserFixture, skillFixture, ...extendedFixtures, browserFormFixture, ...capabilityFixtures()].find(item => caseIdOf(item) === caseId);
  if (!fixture) throw new Error(`Unknown native ToolBench case ${caseId}`);
  return { ...fixture.reference };
}
