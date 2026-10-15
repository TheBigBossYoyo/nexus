Describe to each agent role only the NEXUS tools it uses.

Today rolePrompt in src/main/modules/context/prompts.ts appends the NEXUS_TOOLS text to every role: it describes seven tools (send_message, report_blocker, record_decision, propose_memory, propose_graph_change, package_config_inspect, privileged_request). In tonight's missions reviewers, verifiers and planners never called any of them.

What to do:
- Split NEXUS_TOOLS so that rolePrompt gives:
  - implementing roles (worker, debugger) and the architect: every tool, as today;
  - reviewer, verifier, security_reviewer, researcher and planner: only send_message and report_blocker, in the same words as today.
- The descriptions themselves do not change.
- Add unit tests in tests/unit/context/prompts.test.ts: a worker's role prompt names package_config_inspect and privileged_request; a verifier's names report_blocker but not record_decision, propose_memory, package_config_inspect or privileged_request.

Constraints:
- Do not change anything under native/, src/main/modules/privilege/, electron-builder.yml, package.json or the database migrations.
- Do not push or tag.
