# UI 2 research

2026-10-07. Parent source audit: light/dark semantic tokens, density controls, grouped sidebar, cmdk palette, resizable-pane dependency, per-page headers, connection banners, usage provenance and screenshot fixtures already exist. Evolve those components; replacing them wholesale would discard useful accessibility and recovery behavior. This source audit is not an actual-build visual acceptance.

[Microsoft navigation guidance](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics) supports consistent destinations, clear relationships and fewer competing choices. [Accessibility guidance](https://learn.microsoft.com/en-us/windows/apps/develop/accessibility) emphasizes programmatic names, keyboard operation and contrast. Apply those principles to a restrained, dense engineering interface without copying branding.

Audit gaps to verify in the current build: About/build identity; long sidebar at short window heights; provider availability versus capacity; task compilation provenance; recoverable blocked states; keyboard path from composition to execution. The installed 0.2.1 is not evidence for this audit.
