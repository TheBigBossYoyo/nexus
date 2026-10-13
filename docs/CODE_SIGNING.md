# Code signing, SmartScreen and antivirus: where NEXUS stands

Written 2026-10-13 for 0.9. Two kinds of statement are kept apart: what was read on a primary page (Microsoft
Learn, the CA/Browser Forum, the electron-builder documentation; the date is the page's own) and what was
measured on the owner's machine. What neither supports is marked **not verified**.

## State today (measured, 2026-10-13, packaged 0.8.0)

`node scripts/verify-signatures.mjs release/v08-check/win-unpacked`: 17 Windows program files, 3 signed by
others (the Agent SDK's `claude.exe` by Anthropic; two of Windows' libraries by Microsoft), 14 unsigned, among
them `NEXUS.exe`, `nexus-launch.exe`, `busybox.exe`, the SQLite binding and the setup scripts. The installer is
unsigned. No code-signing certificate is in the owner's store. Smart App Control is off on this machine. A
locally built installer carries no mark of the web, so SmartScreen does not look at it here.

**NEXUS owns no certificate. This blocks public distribution, not the local release.**

## What an unsigned build meets on somebody else's machine

- **SmartScreen** (Microsoft Learn, "SmartScreen reputation", 2026-05-04): a downloaded unsigned installer shows
  "Windows protected your PC"; the user must choose to run it. Every new version starts without reputation.
- **Smart App Control** (Microsoft Learn, 2026-09-30): where it enforces, unknown unsigned code is blocked, not
  warned about, whether it was downloaded or not. A self-signed certificate does not help.
- **Antivirus**: on this machine Bitdefender's behavioural engine flagged the silent uninstall of a test install
  (2026-10-03) and attack-shaped text files outside the excluded project folder. No primary source says that a
  signature reduces behavioural detections; **not verified**.

## What can be had

| Way | Open to the owner? | Notes |
|---|---|---|
| Azure Artifact Signing (the former Trusted Signing) | **No.** Individuals must be in the United States or Canada; organizations in a list of regions without Tunisia (quickstart, updated 2026-10-08) | About 10 USD a month where available |
| An OV certificate from a certificate authority, validated for an individual | **Not verified**: whether an authority validates a resident of Tunisia, with which documents, at which price. To be asked of the authority before paying | Microsoft's figure: 150 to 300 USD a year. Key in a hardware token or a cloud HSM (required since 2023-06-01). Valid 460 days at most when issued after 2026-03-01 (CA/B Forum, ballot CSC-31). SmartScreen still warns until reputation builds, with the publisher's name |
| An EV certificate | For organizations | No longer bypasses SmartScreen (Microsoft, "code signing options", 2026-08-29) |
| Microsoft Store, MSIX | **Not verified** for Tunisia | No certificate needed, but MSIX does not fit: NEXUS's one-time elevated setup makes a local account, firewall rules and a startup task, and writes under Program Files and ProgramData |
| Self-signed | Yes | Gives no public trust; useful only to rehearse the pipeline |

## What to sign when a certificate exists

Everything NEXUS builds or is answerable for: the installer and the uninstaller, `NEXUS.exe`, `nexus-launch.exe`,
the libraries and bindings in the package, the five setup scripts (`Set-AuthenticodeSignature`). With SHA-256
and an RFC 3161 timestamp: without a timestamp a signature ends with a certificate that lives 460 days.

Not `claude.exe` (Anthropic's signature stays). `busybox.exe` is somebody else's unmodified program under the
GPL: left unsigned by default, because a signature changes the file and its recorded hash is what NEXUS checks
before running it (`shell-adapter.ts`), and because the owner's name would vouch for code they did not build.
If Smart App Control makes that untenable, the recorded hash becomes that of the signed file and the notice
says so. The sandbox's copy of `node.exe` is changed by NEXUS on the user's machine and therefore loses the
OpenJS signature; it runs only inside the AppContainer, from a folder NEXUS owns.

## The pipeline, ready and not exercised with a real certificate

1. Put the certificate where signtool finds it (a token or a cloud HSM through the authority's provider; never a
   key file in the repository).
2. Set, in the environment of the build only: `CSC_LINK` and `CSC_KEY_PASSWORD` for a file-based certificate, or
   add to `electron-builder.yml` under `win:` `signtoolOptions: { certificateSha1: <thumbprint>,
   signingHashAlgorithms: [sha256], rfc3161TimeStampServer: <the authority's server> }` for a certificate in the
   store, and `signExts: [.dll, .node]`. `forceCodeSigning: true` makes an unsigned result a failed build.
3. `pnpm package`, then sign the setup scripts in `resources/sandbox-setup` before the installer is made (an
   `afterPack` hook), so that the installer contains the signed scripts.
4. `node scripts/verify-signatures.mjs release/v<version> --require-signed` and the same on the unpacked
   application: fails on any file without a valid, timestamped signature and on any signature that no longer
   holds.
5. `node scripts/release-artifacts.mjs`; set `signing.signed` in the manifest from the result of step 4.

What is tested without a certificate (`tests/integration/packaging/signatures.test.ts`): a signed program reads
as valid; the same program with one byte changed reads as broken and fails the check; an unsigned or
untimestamped file fails the check of a signed release.

Which files electron-builder signs by itself (the uninstaller, the libraries) is **not verified**; step 4 is
what decides.

## Not done, deliberately

Nothing was bought. No Windows security setting was changed. No exclusion was added to any antivirus by NEXUS.
No warning is clicked through by automation.
