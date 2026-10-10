"""Builds docs/V0_7_1_RELEASE_REPORT.md from its 2026-10-07 text and the closing fragments. Run from the repository root."""
import io
import re
import sys

R = 'docs/V0_7_1_RELEASE_REPORT.md'
T = 'test-results/'


def read(p):
    return io.open(p, encoding='utf-8', newline='').read().replace('\r\n', '\n')


s = read(R)
if '## Verdict\n\n**PASS.**' in s:
    sys.exit('already spliced')

tables = read(T + 'campaign-tables.md')
parts = re.split(r'\n(?=### )', '\n' + tables)
section = {p.split('\n', 1)[0]: p.split('\n', 1)[1].strip() for p in parts if p.strip()}
quality = next(v for k, v in section.items() if k.startswith('### Quality'))
efficiency = next(v for k, v in section.items() if k.startswith('### Efficiency'))
totals = '\n\n'.join('**' + k[4:] + '**\n\n' + v for k, v in section.items() if k.startswith('### Totals'))

campaign = read(T + 'report-campaign.md')
for mark, text in (('CAMPAIGN_QUALITY_TABLE', quality), ('CAMPAIGN_EFFICIENCY_TABLE', efficiency), ('CAMPAIGN_TOTALS', totals)):
    assert campaign.count(mark) == 1, mark
    campaign = campaign.replace(mark, text)

# 1. The verdict.
a = s.index('## Verdict')
b = s.index('## What 0.7.1 is')
s = s[:a] + read(T + 'report-verdict.md').strip() + '\n\n' + s[b:]

# 2. The header line.
old = 'Written 2026-10-07. Every figure below names its source; a figure without a source is not in this report.'
assert s.count(old) == 1
s = s.replace(old, 'Written 2026-10-07, closed 2026-10-10. Every figure below names its source; a figure without a source is not in this report.')

# 3. Notes where the closing work changed a conclusion of 2026-10-07.
notes = {
    '## Techniques\n': '> **2026-10-10.** Three rows changed. "Context Graph in agent context" and "Context Engine V3" are **on** by default: the real campaign found them non-inferior in quality and cheaper (see "The real quality campaign"). "Compaction" was verified on one real session for the deliberate trigger (see "Real compaction fidelity"). The rows below are the state of 2026-10-07.\n',
    '## Real-world summary\n': '> **2026-10-10.** This section is the state of 2026-10-07: one real pair, in which the graph cost six extra turns. Its conclusions are superseded by "Why the graph-backed mission took six more turns" and "The real quality campaign" below: the walk is gone, fifty real runs were made against the 0.7.0 sources, and the release lowers cost by default.\n',
    '## Did any optimization make NEXUS worse?\n': '> **2026-10-10.** The first item no longer holds. The graph cost tokens while reaching knowledge took a walk of the tree; with the walk gone it used fewer turns and tokens than 0.7.0 over the six mission categories, at equal quality, and it is on by default.\n',
}
for heading, note in notes.items():
    assert s.count(heading) == 1, heading
    s = s.replace(heading, heading + '\n' + note)

# 4. The closing sections, and everything from "Not verified" on.
c = s.index('## Not verified')
s = s[:c] + campaign.strip() + '\n\n' + read(T + 'report-closing-extra.md').strip() + '\n\n' + read(T + 'report-checks.md').strip() + '\n\n' + read(T + 'report-tail.md').strip() + '\n\n' + read(T + 'report-gate.md').strip() + '\n'

io.open(R, 'w', encoding='utf-8', newline='\n').write(s)
print('spliced', len(s))
