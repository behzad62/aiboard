/** Frozen material failure predicates. Candidate timeouts/schema errors never qualify a control. */
export function matchesMaterialFailure(variant,row,expected){
 if(row.passed||/Invalid public response|candidate wall timeout|Candidate exceeded .*watchdog|pending job limit|InternalError.*interrupted/i.test(row.reason))return false;
 if(variant.id==='B14/primary')return row.assertions.some(a=>!a.passed&&a.label==='snapshot reaches every owned setup beyond pages')||row.reason.startsWith('closeBatch must refuse')&&row.assertions.some(a=>!a.passed&&a.label==='closeBatch must refuse')&&row.safetyFailures.some(f=>f.code==='close-owned-records');
 return row.reason.startsWith(expected.expectedReasonPrefix)&&row.assertions.some(a=>!a.passed&&(!expected.expectedAssertionPrefix||a.label.startsWith(expected.expectedAssertionPrefix)));
}
