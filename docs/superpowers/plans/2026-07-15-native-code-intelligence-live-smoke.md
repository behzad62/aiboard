# Native Code Intelligence Live Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the merged native code-intelligence layer works in a complete Runner V2 Build initiated, monitored, and handed off through the AI Board website.

**Architecture:** A disposable external TypeScript Git repository supplies a known type error, failing refund behavior, cross-file symbols, ignored output, tracked generated code, and vendored code. Runner V2 and the AI Board development site run as hidden local processes; the in-app browser drives the Build while the authenticated Runner audit provides supporting tool-level evidence.

**Tech Stack:** Node.js 24.18.0, TypeScript 6, Node test runner, Git, Runner V2, Next.js development server, in-app browser.

## Global Constraints

- Keep the fixture and Runner state outside `C:\Users\b_a_s\source\repos\ai-discussion-board`.
- Use fixture root `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke`.
- Use state root `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-state`.
- Do not overwrite either root if it already contains unrelated data; stop and report the collision.
- Start Runner V2 on `127.0.0.1:8787` and the website on `127.0.0.1:3000` only when those ports are available.
- Use Full Access for this disposable fixture; final handoff still occurs through the website.
- Never read or print browser storage, cookies, passwords, provider tokens, or model credentials.
- Initiate, monitor, and hand off the Build through the website; local control-plane reads are supporting evidence only.
- Stop only processes started by this plan and preserve fixture and Runner state after the test.

---

### Task 1: Create the seeded TypeScript fixture

**Files:**
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\.gitignore`
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\package.json`
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\tsconfig.json`
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\src\order.ts`
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\src\summary.ts`
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\test\summary.test.ts`
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\generated\schema.generated.ts`
- Create: `C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke\vendor\money.ts`

**Interfaces:**
- Produces: `summarizeOrders(orders: readonly Order[]): OrderSummary`.
- Produces: scripts `npm run typecheck`, `npm run build`, and `npm test`.
- Produces: a committed failing baseline with TS2322 and incorrect refund accounting.

- [ ] **Step 1: Verify destination roots are unused**

Resolve both exact roots. Continue only when each is absent or empty. Create the
parent `C:\Users\b_a_s\source\runner-smoke` and the two empty roots.

- [ ] **Step 2: Write the fixture files**

Use this package contract:

```json
{
  "name": "native-code-intelligence-smoke",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "test": "npm run build && node --test dist/test/*.test.js"
  },
  "devDependencies": {
    "@types/node": "^26.1.0",
    "typescript": "^6.0.3"
  }
}
```

Use `module` and `moduleResolution` `NodeNext`, `target` `ES2022`, `rootDir` `.`,
`outDir` `dist`, and `strict: true`. Include `src/**/*.ts` and `test/**/*.ts`.

Define `OrderStatus = "paid" | "pending" | "refunded"`, an `Order` with
`id`, `amount`, and `status`, and an `OrderSummary` with numeric `netRevenue`,
`pendingCount`, and `refundedCount`. Seed `summarizeOrders` so paid amounts and
pending counts work, refunds are not subtracted, and `refundedCount` is returned
as the string `"0"`. The test supplies paid 100, refunded 20, and pending 40,
and expects `{ netRevenue: 80, pendingCount: 1, refundedCount: 1 }`.

Write `// @generated` in `generated/schema.generated.ts`; export a harmless
money-format helper from `vendor/money.ts`. Ignore `node_modules/`, `dist/`,
`coverage/`, and `generated/`.

- [ ] **Step 3: Install dependencies and record the expected RED baseline**

Run:

```powershell
npm install
npm run typecheck
npm test
```

Expected: installation succeeds; typecheck and test both fail because
`refundedCount` is a string where a number is required. Preserve their complete
outputs for the final report.

- [ ] **Step 4: Commit the failing baseline**

Initialize Git, add ordinary project files, force-add
`generated/schema.generated.ts`, and commit with:

```powershell
git commit -m "test: seed native code intelligence smoke project"
```

Confirm `git status --short` is empty.

### Task 2: Start the local Runner and website

**Files:**
- Create: `C:\Users\b_a_s\source\runner-smoke\runner.stdout.log`
- Create: `C:\Users\b_a_s\source\runner-smoke\runner.stderr.log`
- Create: `C:\Users\b_a_s\source\runner-smoke\website.stdout.log`
- Create: `C:\Users\b_a_s\source\runner-smoke\website.stderr.log`

**Interfaces:**
- Produces: authenticated Runner V2 at `http://127.0.0.1:8787`.
- Produces: AI Board at `http://127.0.0.1:3000`.
- Produces: exact process IDs for safe cleanup.

- [ ] **Step 1: Verify ports and processes**

Confirm ports 8787 and 3000 have no listener. Stop if either belongs to an
unrelated process.

- [ ] **Step 2: Start Runner V2 hidden**

From the AI Board checkout, start:

```powershell
npm run runner:v2 -- --project C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-smoke --state-dir C:\Users\b_a_s\source\runner-smoke\native-code-intelligence-state --port 8787
```

Redirect standard output and error to the exact log files. Capture the process
ID. Read the printed control URL and token from the new log output without
copying the token into conversation text.

- [ ] **Step 3: Start the website hidden**

From the AI Board checkout, start `npm run dev`, redirect logs, capture the
process ID, and wait until `http://127.0.0.1:3000` responds successfully.

- [ ] **Step 4: Confirm health**

Call Runner health with its bearer token and confirm the reported project path
matches the fixture and Node satisfies 24.18.0. Confirm the website response is
the AI Board dashboard.

### Task 3: Connect and launch the Build through the website

**Files:**
- No filesystem changes.

**Interfaces:**
- Consumes: website URL, Runner URL/token, fixture project.
- Produces: one durable Runner V2 Build run ID.

- [ ] **Step 1: Connect the in-app browser**

Select the browser for `http://127.0.0.1:3000`, read its complete control
documentation, open the dashboard, and inspect visible interactive state.

- [ ] **Step 2: Configure Runner V2 in the UI**

Open the Build/Runner setup surface. Enter `http://127.0.0.1:8787`, enter the
control token without echoing it, select Full Access, test the connection, and
confirm the UI displays the fixture project path.

- [ ] **Step 3: Create the Build discussion**

Select available Architect and worker runtimes already configured in the UI.
Use this request verbatim:

```text
Fix the TypeScript order-summary project and implement correct refund accounting. Before editing, use repo.manifest and repo.map to inspect the repository, code.workspace_symbols to find summarizeOrders, code.definition and code.references to trace OrderStatus and summarizeOrders across files, and code.diagnostics to inspect the seeded compiler error. Use fs.patch for the source edit and inspect the changed-file diagnostics returned by that mutation. Do not use process execution for code discovery. Run npm run typecheck and npm test for verification. The final result must report net revenue as paid amounts minus refunded amounts, count pending orders, and count refunded orders. Do not edit generated or vendored files.
```

Start the Build and record its durable run ID from visible UI or authenticated
Runner state.

### Task 4: Monitor and complete the Build

**Files:**
- The Runner may modify the fixture only through task worktrees and final handoff.

**Interfaces:**
- Consumes: durable run ID.
- Produces: settled Build with applied final handoff or a concrete failure report.

- [ ] **Step 1: Monitor live UI state**

Poll visible task board, transcript, status indicators, permission prompts, and
handoff controls without refreshing away durable state. Capture screenshots at
the first active worker state, Architect review, and final handoff when those
states appear.

- [ ] **Step 2: Inspect supporting audit evidence**

Use authenticated read-only Runner endpoints or exported UI audit to confirm
calls to all six required read-only tools, at least one `fs.patch`, and mutation
diagnostic metadata. Do not infer tool use from the final prose.

- [ ] **Step 3: Handle bounded pauses**

For an ordinary permission or provider handoff pause, inspect the exact reason.
Use UI controls only when the required choice is unambiguous and within this
disposable test. Report authentication, missing-model, usage-limit, or repeated
provider failures rather than changing credentials or selecting a materially
different model without user authority.

- [ ] **Step 4: Apply final handoff through the UI**

When Runner V2 presents its mandatory final handoff, choose the UI action that
applies the integrated result to the disposable fixture. Continue monitoring
until the UI and Runner projection both report settlement.

### Task 5: Independently verify and report

**Files:**
- Inspect: fixture source, tests, Git history, and Runner state/logs.

**Interfaces:**
- Produces: evidence-backed pass/fail report for the live smoke test.

- [ ] **Step 1: Run fresh project verification**

From the handed-off fixture run:

```powershell
npm run typecheck
npm test
git status --short
git log --oneline -3
```

Expected: typecheck and tests exit 0; Git state matches the handoff semantics and
contains no unexplained changes.

- [ ] **Step 2: Audit every success criterion**

Map UI connection, durable run state, all required tool calls, mutation
diagnostics, Architect integration, final handoff, typecheck, and tests to
concrete UI, audit, command, or file evidence. Treat missing tool evidence as a
failed smoke criterion even when the project output is correct.

- [ ] **Step 3: Stop owned processes**

Stop only the recorded Runner and website process IDs, verify ports 8787 and
3000 are released, and preserve fixture, logs, screenshots, and Runner state.
