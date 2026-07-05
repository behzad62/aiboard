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
  const b = createBuildWorkerBudget({ difficulty: 3, runsLeft: PHASE_POOL });
  check("difficulty 3: reads 4", b.reads === 4, b);
  check("difficulty 3: runs 2", b.runs === 2, b);
  check("difficulty 3: toolTurns 24", b.toolTurns === 24, b);
}

// difficulty 4 -> HARD tier
{
  const b = createBuildWorkerBudget({ difficulty: 4, runsLeft: PHASE_POOL });
  check("difficulty 4: reads 6", b.reads === 6, b);
  check("difficulty 4: runs 4", b.runs === 4, b);
  check("difficulty 4: toolTurns 32", b.toolTurns === 32, b);
}

// difficulty 5 -> HARDEST tier
{
  const b = createBuildWorkerBudget({ difficulty: 5, runsLeft: PHASE_POOL });
  check("difficulty 5: reads 8", b.reads === 8, b);
  check("difficulty 5: runs 6", b.runs === 6, b);
  check("difficulty 5: toolTurns 40", b.toolTurns === 40, b);
}

// TDD floor: difficulty 2 + TDD skill -> runs floored to 3 (BASE tier would be 2)
{
  const b = createBuildWorkerBudget({
    difficulty: 2,
    activeSkillIds: ["agent:test-driven-development"],
    runsLeft: PHASE_POOL,
  });
  check("difficulty 2 + TDD: runs 3 (TDD floor)", b.runs === 3, b);
}

// Phase pool still caps runs even with strict TDD + hardest tier
{
  const b = createBuildWorkerBudget({
    difficulty: 5,
    activeSkillIds: ["superpowers:strict-test-driven-development"],
    runsLeft: 2,
  });
  check("difficulty 5 + strict TDD + runsLeft 2: runs 2 (phase pool caps)", b.runs === 2, b);
}

// First fix round (failCount 1): difficulty 3 escalates to effective 4 -> HARD tier
{
  const b = createBuildWorkerBudget({ difficulty: 3, failCount: 1, runsLeft: PHASE_POOL });
  check("difficulty 3 + failCount 1: toolTurns 32", b.toolTurns === 32, b);
  check("difficulty 3 + failCount 1: runs 4", b.runs === 4, b);
}

// Second fix round (failCount 2): difficulty 3 escalates to effective 5 -> HARDEST tier
{
  const b = createBuildWorkerBudget({ difficulty: 3, failCount: 2, runsLeft: PHASE_POOL });
  check("difficulty 3 + failCount 2: toolTurns 40", b.toolTurns === 40, b);
  check("difficulty 3 + failCount 2: runs 6", b.runs === 6, b);
}

// Escalation never exceeds hardest tier
{
  const b = createBuildWorkerBudget({ difficulty: 5, failCount: 2, runsLeft: PHASE_POOL });
  check("difficulty 5 + failCount 2: toolTurns 40 (never exceeds hardest)", b.toolTurns === 40, b);
}

// failCount capped at +2: difficulty 1 + failCount 5 -> effective 3 -> still BASE tier
{
  const b = createBuildWorkerBudget({ difficulty: 1, failCount: 5, runsLeft: PHASE_POOL });
  check("difficulty 1 + failCount 5: toolTurns 24 (failCount capped, effective 3 stays BASE)", b.toolTurns === 24, b);
}

// workerBudgetToolInstructionInput omits toolTurns/badToolCalls and keeps runs
{
  const hard = createBuildWorkerBudget({ difficulty: 4, runsLeft: PHASE_POOL });
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
}

process.exit(failed === 0 ? 0 : 1);
