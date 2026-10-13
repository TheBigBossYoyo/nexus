# NEXUS 0.9.0

Written 2026-10-13. Branch `nexus-0.9-production-proof`, on top of `main` (`v0.8.0`, `ab54281`). The list of
everything open is `V0_9_HARDENING_LEDGER.md`; what stands between this and a 1.0 candidate is
`1_0_READINESS.md`.

## Verdict

**PARTIAL against the gates 0.9 was given. Part one of 0.9.0, closed by the owner's decision; not merged and not tagged yet.**

The brief for 0.9 sets seven gates and says: if any release-material gate remains, PARTIAL, no merge, no tag.
Measured against that, 0.9.0 is PARTIAL: the installer was not run, there was no soak, no crash campaign, no
Arena campaign, no real Program, Workspace or night, no independent UX review, and ten MEDIUM findings of the
security review are open.

On 2026-10-13 at 18:33 the owner asked for 0.9.0 the same evening and said to leave the long items out and to
take shortcuts; at 19:20 they added a pillar to 0.9.0 (network resilience, the Director Line, progress and ETA)
to be built after this part. So this report covers part one: the hardening and the release engineering done in
one day, validated by the suite, the end-to-end tests and the package. It is not the "production proof" the
brief describes, and it is not called PASS. The merge to `main` and the tag `v0.9.0` wait for the pillar: one
tag for one version. Nothing is pushed. The package named below is of part one and will be built again.

| Gate of the brief | State |
|---|---|
| Security | PARTIAL: first restart observed; second review done; the CRITICAL and the HIGH findings fixed for what was reproduced; a capability per session. Open: ten MEDIUM, reading between sessions, no final review, the launcher read and not attacked by the second party |
| Autonomy | NOT SHOWN on this source: no real mission was run on 0.9.0. The scenario and end-to-end tests pass |
| Release engineering | PARTIAL: package built from a clean tree and checked, manifest, bill of materials, notices, checksums, license obligations met, signing state stated. The installer, the upgrade, the uninstall and the restart after an install were not run |
| Reliability | NOT SHOWN: no soak, no crash campaign. The limits of a soak were fixed beforehand and its analyzer is tested |
| Quality | NOT SHOWN: no Arena campaign, no AUTO evidence |
| App / research | PARTIAL: the browser, Electron and research tests of the suite pass under the new capabilities; no campaign |
| UX | NOT SHOWN: no independent review |

## First Real v0.8 Reboot Observation

`docs/acceptance/v09-first-real-reboot-2026-10-13.md`. Observed before anything was changed: a full start of
Windows (boot type 0x0); the packaged 0.8.0 reported ISOLATED available 6.6 s after its launch, verified by
running it; no elevation prompt; 0 interruptions. The startup task ran 25 s after the kernel started. The 34
hostile containment tests of the 0.8.0 source passed afterwards; Node's native `realpath` works inside. Not
answered: whether the task restored the Mount Manager entry or found it there (it keeps no record). One
restart, not a matrix.

## Security Hardening

**Session capability isolation.** Every contained command now holds, beside the capability all sessions hold,
one of its session's own and one of its project's. A session's worktree, temporary directory and home are
opened for writing to that session's capability only; the package cache to the project's. The command's
process, its first thread and the default access list of its token name the session's capability and not the
AppContainer, so another session cannot open its processes or what they create. The launcher reads every
capability back from the token before the command runs, and takes only names of NEXUS's own making. Test: two
hostile sessions at once, and one of another project (`tests/integration/isolation/cross-session.test.ts`):
no write to the other's worktree, temporary directory or home, no ending of its process, no write to another
project's cache. **Open:** a session still reads another's worktree.

**Trusted Git objects.** Not done. What was done in git: the CRITICAL finding of the review. A speculative
candidate's clone could redirect its repository (`commondir`, or a `.git` pointer) and have NEXUS's own git
run a program of its choosing as the user. NEXUS now names the clone's Git directory itself for every command
and refuses anything in the clone that redirects it; the winner's commits are fetched from that directory with
every object checked (`tests/integration/git/worktree-pointer-trust.test.ts`). An object store of the task's
own remains for the next release.

**Link scan.** Not done.

**Privileged bootstrap.** Reviewed by the second reader: the task's definition, script and folder are sound on
this machine. Open: the elevated scripts compile and write in the user's temporary folder (W2-F3, W2-F4), and
the task records no result.

**Independent reviews.** Four readers on the 0.8.0 source: 1 CRITICAL, 3 HIGH, 16 MEDIUM, about 25 LOW. Closed
with tests: the CRITICAL; the HIGH for writing and for processes (shared tools writable; one capability for
all sessions; the inner spec left behind); MEDIUM: a URL an agent names as a way out, the provider's own web
tools, a mission-wide grant without the native confirmation, the package configuration reader, a launcher spec
without an AppContainer; several LOW. One reader was stopped by the provider's safety filter after its first
finding; nothing was done to get around that, and a second reader read the same scope without launching
anything. Each finding with its state: ledger, section E.

**Node compatibility.** Not done: the change to the sandbox's node.exe is as in 0.8, and the compatibility
policy and the runtime probe remain for the next release.

## Installation

Not run: clean install, upgrade, uninstall, reinstall, restart after an install. The package was built and
started (Built from a clean tree at `ed9c18a` (`pnpm package`): `NEXUS-Setup-0.9.0.exe`, SHA-256 `3216e0d41f7029e826f1c2c94338a1a0293cd36e043a28afac51f0747b4a24ee`. The unpacked application was started off-screen on a data directory of its own (`scripts/v08-packaged-check.mjs`): 17 checks of 17. It is the package of that commit and of version 0.9.0, channel `release`, schema 19, runtime protocol 1; the runtime is ready and its endpoint restricted; both profiles are verified by running them from the package, ISOLATED as the sandbox account, with the contained attempt to write the shared tools refused; every page renders; it stops cleanly. Evidence: `docs/acceptance/v09-packaged-check-2026-10-13.json`. The commit that follows `ed9c18a` adds this report and that evidence file only.).

## Distribution

- **Signing:** nothing is signed and no certificate is owned. Microsoft's Artifact Signing is closed to
  individuals outside the United States and Canada; an individual certificate from an authority is the open
  way and was not bought. `CODE_SIGNING.md`. The check of signatures is tested with a changed byte.
- **SmartScreen, antivirus:** not exercised on an installer; what an unsigned build meets is in
  `CODE_SIGNING.md`. No security setting was changed.
- **BusyBox licensing:** the license text, the notices and the complete source of the shipped commit go beside
  the installer (GPL-2.0, section 3(a)); a build stops on a binary that is not the one on record.
- **SBOM, checksums:** `release/v0.9.0/`: the installer and its block map, `build-manifest.json` (commit, version, lock hashes, native binaries with their hashes and sources, schema, protocol, setup version 3, toolchain, signing state), `sbom.cdx.json` (CycloneDX 1.7, 265 components: the production dependencies, Electron, busybox-w32, the launcher), `THIRD_PARTY_NOTICES.md`, `licenses/`, `source/` (busybox-w32 at the shipped commit), `SHA256SUMS` over all of it, read back after writing. Built once; a second build for comparison was not made.
- **Dependencies:** no known vulnerability in what ships (`pnpm audit --prod`); two advisories in the packaging
  tool's own dependencies, which do not ship.
- **Secrets:** a scan of the documents, the real data directory, the development data and the test artifacts
  found no credential.

## Reliability

No soak, no crash campaign, no sleep or network campaign. `V0_9_SOAK_THRESHOLDS.md` fixes what a soak will be
judged by. One teardown of one test file failed once under load (`V0_9_FLAKES.md`), cause not established.

## Programs / Workspaces / Overnight / Provider recovery / Director / Task Compiler / Arena / Context Graph / Token Intelligence

No run on 0.9.0 beyond the suite. The subscription's weekly window stood at 52% on the morning of 2026-10-13.

## Browser / Electron / Research

The tests of the suite, under the per-session capabilities. The research tools refuse a URL that is data
(query length and count, runs of encoded text, credential shapes, credentials of this machine) and count a
budget per registrable domain; in an enrolled project the provider's own web tools are neither offered nor
allowed.

## UX / Accessibility

No review. One change a user meets: allowing a boundary request for the whole mission now asks for the native
confirmation, as allowing for the whole project did.

## Tests

`pnpm test` on `ed9c18a`, the packaged commit, nothing beside it: **247 files, 4,773 tests, all passed** (787 s). Typecheck (both projects) and lint clean. The runs before it are kept as they were: 245 of 246 files on the first run of the branch (a teardown refused a directory once, `V0_9_FLAKES.md`); 246 of 247 on the commit before `ed9c18a`, where the one failure was a new test of this release that looked at a folder other tests were writing at the same moment, and was corrected. The isolation tests alone: 6 files, 91 tests. Not run: the 1,000-seed orchestrator stress and the other stress suites.

## E2E

`pnpm test:e2e` on `ed9c18a`'s source (the build, then Playwright on the built application): 42 passed, 3 skipped, 17.5 minutes. The three skipped are the capture specs, as in 0.8.

## Package

Built from a clean tree at `ed9c18a` (`pnpm package`): `NEXUS-Setup-0.9.0.exe`, SHA-256 `3216e0d41f7029e826f1c2c94338a1a0293cd36e043a28afac51f0747b4a24ee`. The unpacked application was started off-screen on a data directory of its own (`scripts/v08-packaged-check.mjs`): 17 checks of 17. It is the package of that commit and of version 0.9.0, channel `release`, schema 19, runtime protocol 1; the runtime is ready and its endpoint restricted; both profiles are verified by running them from the package, ISOLATED as the sandbox account, with the contained attempt to write the shared tools refused; every page renders; it stops cleanly. Evidence: `docs/acceptance/v09-packaged-check-2026-10-13.json`. The commit that follows `ed9c18a` adds this report and that evidence file only.

## Left out by the owner's decision

Per-session reading; the object store of the task's own; the link scan; the Node compatibility policy and the
runtime probe; the open MEDIUM findings; the startup task's result record and the versioned setup state; the
installer lifecycle; signing; the reboot matrix; sleep, network and disk campaigns; the soak; the crash
campaign; real Programs, Workspaces and a night; the power action; quota recovery; Director, Council, Task
Compiler and Arena campaigns; Context Graph and token measurements; the UX and accessibility reviews; the
diagnostic bundle and the recovery path; the performance baseline against 0.8; the final independent review.

## Known Limitations

Those of 0.8 that this release did not close (ledger, section A), and: sessions read one another's worktrees;
a real mission was not run on this source, so the capability per session met only the tests; a packaged run
that grants for a mission shows a dialog.

## 1.0 Readiness

NOT READY. Seven blockers, in `1_0_READINESS.md`.
