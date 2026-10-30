# L2 release review — 2026-10-30

Release `0.2.0` is **not approved for signing**. The independent review covered PR #109 at `ef529ff62a91d15f6b8125d4ade63ff6ba04b5af`; no security acceptance was issued. Work after that revision is provisional until independently reviewed and tested.

## Installer and release findings

1. **Install/update lock ownership:** installers and updater could remove an ownerless, stale-looking, or replaced lock. Windows uninstall also released the lock before publishing and executing its deferred cleanup, which can race a subsequent install and delete its files or state. The acquisition changes in `5912525d` do not close the deferred Windows cleanup race; ownership must cover the destructive handoff and cleanup.
2. **Same-version repair:** the reviewed installers could report success without verifying a damaged installed version. The first repair at `5912525d` still executed the retained verifier before authenticating it. Follow-up `5c1bc493` stages a signed-checksum-verified bundle and uses its verifier to compare the installed inventory; the follow-up requires independent review and hosted platform evidence.
3. **Sequence monotonicity:** explicit release sequences could repeat or regress. `e1d3c1f1` compares against authenticated history; `285ce35a` adds a separate previous-channel history witness for key rotation or changed origins/floors. Both require re-review, including compromised-key recovery and preservation of the new installers' trust anchors.
4. **Copilot bundle:** the account peer runner imports a Copilot helper that the release bundle omits; its target-specific dependencies also need to be included and verified if this capability is shipped.
5. **Bounded processes:** the shell and PowerShell installers do not bound the staged inventory and smoke processes. A hang must not release a lock or clean up files while the child may still run.
6. **Redirect transport:** the shell wget fallback and updater's automatic redirects can follow HTTPS to HTTP; integrity is still protected by signatures and hashes, but the documented HTTPS-only transport is not established. Audit PowerShell redirects too.
7. **Retained local inventory:** the updater checks a mutable installed inventory against mutable files; a local writer able to change both is outside what that check authenticates. Do not claim that check alone defeats a local attacker.

## CI and filesystem investigation

- The [installer matrix](https://github.com/behzad62/aiboard/actions/runs/41086963238) passed at `ef529ff6`; it does not validate later fixes.
- The [portable workflow](https://github.com/behzad62/aiboard/actions/runs/41086963232) exposed an unchanged `main` ownership-audit failure and a Linux missing-path assertion. A focused reproduction on main confirmed the ownership-audit failure. The independent reviewer found 27 mutation-capable owners outside the audit's reviewed list; they have not been cleared and must not be blanket-allowlisted.
- The Linux missing-path assertion predates the `fs.stat` contract that returns `{ exists: false }`. `d545a2da` retains hidden-alias and hidden-content checks and updates only that missing-path control. The focused case passed on Windows and in a Linux Node 24 container; macOS and integrated evidence remain pending.
- The reviewer identified possible external report deletion through a symlinked workspace parent in `delivery-execution.ts` cleanup, and a stale-lock replacement race in `extension-registry.ts`. Both require bounded reproductions and ownership-safe fixes; neither is cleared.
- The [benchmark workflow](https://github.com/behzad62/aiboard/actions/runs/41086963198) failed a cancellation test on unchanged main because its fake runner lacked the browser capability required by the current ToolBench suite. `f5769ef6` and `65e93ee4` update that fixture and add a browser-unavailable negative control; targeted local tests passed, hosted evidence remains pending.

No draft release or signed production manifest has been created. Do not merge or publish while these findings are unresolved. The live site remains at its previously deployed revision, with installers failing closed because no signed manifest exists.
