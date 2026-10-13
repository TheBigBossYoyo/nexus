# First observed restart of Windows after NEXUS 0.8.0 (2026-10-13)

Evidence: `v09-first-real-reboot-2026-10-13.json` (same folder). Observed before anything was changed: no setup,
no repair, no elevation.

| | |
| --- | --- |
| Build observed | packaged 0.8.0, commit `3795306`, clean, schema 19, runtime protocol 1 (`release/v08-check/win-unpacked`) |
| Windows | 11 Pro 10.0.26200, ordinary session, Bitdefender active |
| Restart | stopped 10:32:32Z, started 10:32:43Z, boot type `0x0` (a full start) |
| First look | 109 s after the start; no NEXUS process was running |

**Verdict: PASS. User interruptions: 0. UAC prompts: 0.**

## What was found

- The sandbox account, the machine's record (setup version 3), both firewall rules and the privileged script
  were as the setup left them. Nobody but the system and administrators can write the script or its folder.
- The startup task `NexusSandbox-RestoreCanonicalization` ran 25 s after the kernel started (PowerShell engine
  start logged at 10:33:08Z with the script and no other argument).
- The capability's entry on the Mount Manager device was there, exactly as intended (`FX`, one entry).
- NEXUS, started normally, reported `ISOLATED` available 6.6 s after launch, verified by running it: sandbox
  account in the AppContainer, refused beside its directory, refused a protected file and a file of the user's
  profile, no route to the Internet, no name looked up (three ways), not shown the name cache, canonical paths
  given. The start changed nothing on the device.
- The hostile tests of the 0.8.0 source, run after the restart: 34/34. Node's native `realpath` works inside
  ISOLATED; every change to the Mount Manager is refused; names are refused seven ways; the name cache shows 2
  lines inside against 115 outside.

## What could not be answered

- **Did the task restore the entry, or was it already there?** Not known. The task keeps no record of its
  result, an ordinary user cannot read the task's last run, and the Task Scheduler log is off on this machine.
  This is the first item of the 0.9 hardening ledger.

## Also seen

- This was the second full start since the task was registered: one at 06:01Z the same day (the task ran then
  too), which nobody looked at. A fast startup at 09:15Z did not run the task and the entry survived with the
  restored kernel session.
- `C:\ProgramData\NexusSandbox\bin` holds about 200 old copies of the launcher from development builds.
- Windows still lists "NEXUS 0.7.0" as installed, from an earlier installer test.
