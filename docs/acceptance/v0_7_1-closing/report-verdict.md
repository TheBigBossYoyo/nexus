## Verdict

**PASS.** Written 2026-10-10. The sections of 2026-10-07 below are kept as they were written, with a note
where the closing work changed their conclusion; "Closing work, 2026-10-10" holds what was done since.

The report of 2026-10-07 was PARTIAL for one missing requirement, with two more open: the real campaign
against 0.7.0 had one pair instead of eight categories, compaction fidelity had never been seen on a real
session, and the tool-definition lever had not been evaluated for security. All three are closed:

- **The campaign was run**: fifty real runs over the eight task categories, 0.7.1 against the sources of
  0.7.0. No case is worse on 0.7.1. The quality gate finds 0.7.1 non-inferior, with the Context Graph off
  and with it on.
- **The release now lowers cost by default.** With the Context Graph on, missions used 16% fewer turns, 7.5%
  less input and 14% less output than on 0.7.0 over the six mission categories, at equal quality. It is on
  for agents by default. On 2026-10-07 it cost six extra turns in its one real run; that was a walk of the
  tree, which is gone (one context tool call in sixteen runs).
- **Compaction was observed on a real session**: 27 of 28 facts kept, all 15 that existed only in the
  conversation, and the task continued correctly. The automatic trigger was not exercised.
- **Tool definitions were evaluated and are not shared across roles**: the authorizer's allow-set is the tool
  list, so sharing it would give reviewers real write access. Security preserved.

What the campaign also did, and what a reader should know before relying on this release:

- It found defects that are not about tokens and fixed them: a real program was blocked in every version,
  0.7.0 included, on a correct judgment written in the wrong form; the quality gate could call a variant
  inferior that was worse on no case; the security tests alarmed the user's antivirus on every run.
- Its figures are from one to six runs per cell. The quality result is a gate verdict over eight paired
  cases with no case worse. The cost figures are what these runs measured, with a consistent direction in
  four of six mission categories; they are not a proven effect size.
- A mission can still end paused on a review task its planner added, with the work verified (the security
  task, in every arm, as on 0.7.0), and an agent that writes through the shell asks for an approval an
  unattended run cannot give. Neither is new and neither is fixed here.

See "Release gate" for each requirement.
