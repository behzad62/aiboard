# REL-1 release runbook

Status: **PREPARED — deployment NOT STARTED.** The owner authorized the local T8 merge and release preparation. Pushing `main`, dispatching the deployment workflow, changing production or marking REL-1 complete remains a separate release action.

REL-1 is the single production release of the accepted integration. T8 acceptance proves the implementation; REL-1 records the exact release, executes the existing build/deployment pipeline, verifies the published site/downloads and retains a concrete rollback route.

## Pinned identity

| Item | Value |
|---|---|
| Accepted T8 tip | `a750ef6cc4efe990b25c7fac3dd992f2745798e8` |
| Integration code merge | `d88f1e9aa5362841ab8f53963ddafb999f07e973` |
| Exact release ref | Local annotated tag `rel1-ready-20261015`, sealed to the documentation-only preparation child of the integration merge; it must resolve to local `main` before release. |
| Previous main / rollback target | `5e5e71c882fb8fe972232819e2270d03f1e2063f` |
| Last successful production workflow | [Deploy AI Board run 38587699717](https://github.com/behzad62/aiboard/actions/runs/38587699717), success at the rollback commit, 2026-10-14 15:17:07 UTC. This is the last recorded successful workflow, not an assertion that no manual server change occurred afterward. |
| Repository / deployment workflow | `behzad62/aiboard`, `.github/workflows/deploy-aiboard.yml` |
| Production destination | Existing static site `aiboard.me`, existing `/var/www/aiboard.me/` publish path. FunBoard workflows and deployment paths are separate and unchanged. |

The full release SHA and evidence hashes are sealed in `D:/tmp/rel1-20261015-merge-preparation/ready.json`. This external receipt avoids embedding a commit's own hash in its tree. The immutable local tag provides the repository-native exact-commit reference. Do not move that tag or silently substitute a newer `main`.

## Accepted validation and merge-specific checks

- T8/Gate G remain accepted under the explicit no-passed-test-replay instruction. Preserve the individual original successes, recoveries, failures, host skips and resource limitations; never represent them as one green stock invocation.
- The merge preserves T8's exact `runner-v2/src`, `bin`, `skills` and Runner package source, main's independent features/account-runner changes and legal policy, and the dependency versions. The only overlapping text file was `package.json`, merged with main's license declaration and T8's test commands intact.
- Three generated ZIP conflicts were resolved by publishing from the merged source. Native/embedded/RJS executable members match accepted T8; differences are the current main legal/README/package metadata and derived RJS manifest. The account-provider ZIP is byte-identical to pre-merge main, including its current protocol version. Actual ZIP hashes and per-member deltas are in `merge-audit.json` beside `ready.json`.
- Full merged-app TypeScript check: exit 0, `merged-types.{log,exit}`. No production build ran in the active development checkout and no existing `.next` or `out` was replaced for validation.
- The inherited whole-merge whitespace diagnostics match the T8 parent exactly; the new conflict-resolution delta passes. Historical evidence text was preserved, not reformatted to conceal the diagnostics.
- Merge-resolution independent review: `D:/tmp/rel1-20261015-merge-preparation/merge-resolution-review.md`. T8's independent final review and original accepted CI/build/UI/package/host records remain linked from its acceptance document. This is not a claim of fresh full T8/hosted CI on the integration merge.

The existing deployment workflow supplies the remaining exact-release layer-4 build/export check: Node 24.x, acquire the pinned RJS Runner, `npm ci`, publish downloads, production static build, verify workflow/exported download artifacts, then upload and publish. Build and artifact verification must succeed before upload. Keep any new failure in its owning bounded scope; do not restart the accepted T8 suite or weaken assertions/timeouts.

## Start only when the owner authorizes REL-1 deployment

1. Confirm clean local `main`, confirm the sealed tag equals `main`, and confirm remote `main` is still the rollback baseline. If another change has landed, stop and reconcile that new delta; do not force-push or silently extend this release.

   ```powershell
   git status --short
   git rev-parse main
   git rev-parse 'refs/tags/rel1-ready-20261015^{commit}'
   git ls-remote --heads origin main
   ```

2. Record the exact resolved release SHA, the rollback SHA and the current validation/evidence manifest. The preparation commit must differ from the integration code merge only in this runbook and the linked preparation/status documentation.
3. Once authorized, push the sealed main and tag without force. **This starts production deployment automatically**, and may start other configured main-branch CI. Do not dispatch a duplicate deployment or manually replay already accepted T8 jobs.

   ```powershell
   git push --atomic origin refs/heads/main refs/tags/rel1-ready-20261015
   ```

4. Select the `Deploy AI Board` workflow run whose `head_sha` equals the sealed release SHA. Retain its URL and actual conclusion. Check its build, artifact verification, upload, `nginx -t` and reload steps; a queued/running workflow is not a completed release.
5. After success, verify the deployed dashboard/settings/discussion load, Build still uses the separate localhost Runner, current download ZIPs match the recorded manifest, and project handoff still requires the user's choice. Do not make paid model calls or mutate a real project merely for a smoke check without authorization.
6. Record the exact SHA, run URL, observed smoke outcomes and rollback target. Only then mark REL-1 complete in the execution ledger. Do not mark the old T8 evidence as fresh release-head CI.

## Rollback if the authorized release fails

Redeploy the previously successful exact main commit `5e5e71c882fb8fe972232819e2270d03f1e2063f` through the same static-site workflow. Preserve Git history; do not reset or force-push main. With owner rollback authorization, publish a dedicated rollback branch at that exact commit and dispatch the existing workflow on it:

```powershell
git push origin 5e5e71c882fb8fe972232819e2270d03f1e2063f:refs/heads/rel1-rollback-20261015
gh workflow run deploy-aiboard.yml --ref rel1-rollback-20261015
```

If the rollback branch already exists at another SHA, stop rather than overwrite it. Retain the rollback run URL, verify its exact `head_sha` and success, and repeat the static-site/download smoke checks. A rollback dispatch is not rollback success. This plan does not alter Runner-owned local user projects or unrelated FunBoard deployment state.

## Generated download identities

| Download | SHA256 |
|---|---|
| `aiboard-runner-v2.zip` | `e9d38a73cee6414da7b77a8c819ac4d9981c6b76a58e8b636e26cc6778e16e3b` |
| `aiboard-workbench-runner.zip` | `81c7e993948e05807db4d4f007d41ed4d64ace605adb9423bb0486b60fea4fdf` |
| `aiboard-rjs-workbench-runner.zip` | `da1aba37bf7951cd157409b13de88119efdb4aea74c760b17220ac71282f6318` |
| `aiboard-account-provider-runner.zip` | `5b2d2581b8bfd87e34b1a5a9eaecc11e098188218875ff67be0e0cfa698f718b` |

These are merged-release bundles; T8 historical archive hashes remain historical. Native execution members are unchanged, while legal/package metadata reflects current main.
