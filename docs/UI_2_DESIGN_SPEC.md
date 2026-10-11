# NEXUS UI 2 design specification

Light-first; existing semantic colors remain canonical with complete dark equivalents. Native fonts; tabular metrics; comfortable/compact density; visible focus; reduced motion. Use existing PageHeader, Button, Field, Notice, KeyValue, tabs, status and dialog components.

Work: Home, Projects, Missions, Programs, Workspaces, Agents. Intelligence: Director, Context, Arena, Policy, Intelligence Capacity and Providers. System: Control Plane, Activity, Overnight, Settings. Preserve stable shortcuts while migrating navigation. About shows embedded version, commit, build timestamp/channel, runtime protocol and schema; package identity never consults live Git.

Home centers active work and attention. Task composer defaults to AUTO, retains an EXACT option and exposes original/compiled/assumptions/evidence/provenance progressively. No fake progress percentages. A required user decision is explicit and blocks Start. Director shows bounded decision history, independent challenge and unresolved disagreements. Capacity separates provider facts, local observed usage and reserve policy; unknown allowance has no progress bar.

Use tables/lists for repeated records, bounded queries for history, contextual inspectors and persisted pane sizes. At 1024/1100 collapse secondary detail deliberately; test 1280, 1440 and 1920 too. Long content wraps or provides accessible full text. Keep error/retry, loading, empty, disconnected, quota and auth states visible.

Acceptance requires actual latest-build screenshots, two independent UI reviews with fixes between them, keyboard validation and final post-change E2E. Source inspection alone does not satisfy these gates.
