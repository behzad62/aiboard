/** Quick regression check for createBuildWorkerBudget (run: npx tsx scripts/test-build-worker-budgets.mts) */
import {
  createBuildWorkerBudget,
  workerBudgetToolInstructionInput,
} from "../lib/orchestrator/build-worker-budgets";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const PHASE_POOL = 1000; // large enough that the phase pool never caps runs in these cases

// difficulty 3 -> BASE tier
{
  const b = createBuildWorkerBudget({ difficulty: 3, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  check("difficulty 3: reads 4", b.reads === 4, b);
  check("difficulty 3: runs 3", b.runs === 3, b);
  check("difficulty 3: toolTurns 24", b.toolTurns === 24, b);
}

// Default difficulty (omitted) -> BASE tier; runsLeft 36 does not cap runs at 3.
{
  const b = createBuildWorkerBudget({ runsLeft: 36, fetchesLeft: PHASE_POOL });
  check("default difficulty + runsLeft 36: toolTurns 24 && runs 3", b.toolTurns === 24 && b.runs === 3, b);
}

// difficulty 4 -> HARD tier
{
  const b = createBuildWorkerBudget({ difficulty: 4, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  check("difficulty 4: reads 6", b.reads === 6, b);
  check("difficulty 4: runs 6", b.runs === 6, b);
  check("difficulty 4: toolTurns 32", b.toolTurns === 32, b);
}

// difficulty 5 -> HARDEST tier
{
  const b = createBuildWorkerBudget({ difficulty: 5, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  check("difficulty 5: reads 8", b.reads === 8, b);
  check("difficulty 5: runs 9", b.runs === 9, b);
  check("difficulty 5: toolTurns 40", b.toolTurns === 40, b);
}

// TDD floor: difficulty 2 + TDD skill -> runs remains at the base 3-run budget.
{
  const b = createBuildWorkerBudget({
    difficulty: 2,
    activeSkillIds: ["agent:test-driven-development"],
    runsLeft: PHASE_POOL,
    fetchesLeft: PHASE_POOL,
  });
  check("difficulty 2 + TDD: runs 3", b.runs === 3, b);
}

// Phase pool still caps runs even with strict TDD + hardest tier
{
  const b = createBuildWorkerBudget({
    difficulty: 5,
    activeSkillIds: ["superpowers:strict-test-driven-development"],
    runsLeft: 2,
    fetchesLeft: PHASE_POOL,
  });
  check("difficulty 5 + strict TDD + runsLeft 2: runs 2 (phase pool caps)", b.runs === 2, b);
}

// First fix round (failCount 1): difficulty 3 escalates to effective 4 -> HARD tier
{
  const b = createBuildWorkerBudget({ difficulty: 3, failCount: 1, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  check("difficulty 3 + failCount 1: toolTurns 32", b.toolTurns === 32, b);
  check("difficulty 3 + failCount 1: runs 6", b.runs === 6, b);
}

// Second fix round (failCount 2): difficulty 3 escalates to effective 5 -> HARDEST tier
{
  const b = createBuildWorkerBudget({ difficulty: 3, failCount: 2, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  check("difficulty 3 + failCount 2: toolTurns 40", b.toolTurns === 40, b);
  check("difficulty 3 + failCount 2: runs 9", b.runs === 9, b);
}

// Escalation never exceeds hardest tier
{
  const b = createBuildWorkerBudget({ difficulty: 5, failCount: 2, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  check("difficulty 5 + failCount 2: toolTurns 40 (never exceeds hardest)", b.toolTurns === 40, b);
}

// failCount capped at +2: difficulty 1 + failCount 5 -> effective 3 -> still BASE tier
{
  const b = createBuildWorkerBudget({ difficulty: 1, failCount: 5, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  check("difficulty 1 + failCount 5: toolTurns 24 (failCount capped, effective 3 stays BASE)", b.toolTurns === 24, b);
}

// ── fetch budget by tier (capped by the shared phase pool) ──────────────────

// BASE tier: fetches 2 (fetchesLeft high enough not to cap).
{
  const b = createBuildWorkerBudget({ difficulty: 3, runsLeft: PHASE_POOL, fetchesLeft: 24 });
  check("difficulty 3: fetches 2", b.fetches === 2, b);
}

// HARD tier: fetches 3.
{
  const b = createBuildWorkerBudget({ difficulty: 4, runsLeft: PHASE_POOL, fetchesLeft: 24 });
  check("difficulty 4: fetches 3", b.fetches === 3, b);
}

// HARDEST tier: fetches 4.
{
  const b = createBuildWorkerBudget({ difficulty: 5, runsLeft: PHASE_POOL, fetchesLeft: 24 });
  check("difficulty 5: fetches 4", b.fetches === 4, b);
}

// Shared phase pool caps fetches: fetchesLeft 1 -> 1 even on the hardest tier.
{
  const b = createBuildWorkerBudget({ difficulty: 5, runsLeft: PHASE_POOL, fetchesLeft: 1 });
  check("fetchesLeft 1 caps fetches to 1", b.fetches === 1, b);
}

// No fetch pool left -> 0 (no runner / pool exhausted).
{
  const b = createBuildWorkerBudget({ difficulty: 5, runsLeft: PHASE_POOL, fetchesLeft: 0 });
  check("fetchesLeft 0 -> fetches 0", b.fetches === 0, b);
}

// Non-finite fetchesLeft -> 0 (finite-floor).
{
  const b = createBuildWorkerBudget({ difficulty: 3, runsLeft: PHASE_POOL, fetchesLeft: Number.POSITIVE_INFINITY });
  check("non-finite fetchesLeft -> fetches 0", b.fetches === 0, b);
}

// failCount escalation also raises the fetch budget: difficulty 3 + failCount 1 -> HARD -> fetches 3.
{
  const b = createBuildWorkerBudget({ difficulty: 3, failCount: 1, runsLeft: PHASE_POOL, fetchesLeft: 24 });
  check("difficulty 3 + failCount 1: fetches 3 (escalated to HARD)", b.fetches === 3, b);
}

// workerBudgetToolInstructionInput omits toolTurns/badToolCalls and keeps runs
{
  const hard = createBuildWorkerBudget({ difficulty: 4, runsLeft: PHASE_POOL, fetchesLeft: PHASE_POOL });
  const instr = workerBudgetToolInstructionInput(hard);
  check("tool instruction input omits toolTurns", !("toolTurns" in instr), instr);
  check("tool instruction input omits badToolCalls", !("badToolCalls" in instr), instr);
  check("tool instruction input keeps runs", instr.runs === hard.runs, instr);
  check(
    "tool instruction input carries reads/rangeReads/searches/patches/appends",
    instr.reads === hard.reads &&
      instr.rangeReads === hard.rangeReads &&
      instr.searches === hard.searches &&
      instr.patches === hard.patches &&
      instr.appends === hard.appends,
    instr
  );
  check("tool instruction input carries fetches", instr.fetches === hard.fetches, instr);
}

process.exit(failed === 0 ? 0 : 1);
