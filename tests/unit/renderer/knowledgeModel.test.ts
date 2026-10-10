import { describe, expect, it } from 'vitest'
import { CONTEXT_EDGE_TYPES, CONTEXT_NODE_TYPES, CONTEXT_STATUSES, CONTEXT_TRUSTS, type ContextNode } from '@shared/context-graph'
import { CACHE_MISS_CAUSES, REQUEST_COMPONENTS, cacheReadShare } from '@shared/token'
import {
  COMPONENT_LABEL,
  MISS_CAUSE_LABEL,
  STATUS_LABEL,
  TRUST_LABEL,
  TRUST_MEANING,
  edgeLabel,
  groupRelations,
  percent,
  statusNotice,
  statusTone,
  trustTone,
  typeLabel,
} from '../../../src/renderer/src/views/knowledge/knowledgeModel'

describe('knowledge view model', () => {
  it('has wording for every trust, status, node type, relation, component and cause', () => {
    for (const t of CONTEXT_TRUSTS) expect(TRUST_LABEL[t] && TRUST_MEANING[t] && trustTone(t)).toBeTruthy()
    for (const s of CONTEXT_STATUSES) expect(STATUS_LABEL[s] && statusTone(s)).toBeTruthy()
    for (const t of CONTEXT_NODE_TYPES) expect(typeLabel(t)).toMatch(/^[A-Z][a-z ]+$/)
    for (const e of CONTEXT_EDGE_TYPES) expect(edgeLabel(e, 'out') && edgeLabel(e, 'in')).toBeTruthy()
    for (const c of REQUEST_COMPONENTS) expect(COMPONENT_LABEL[c]).toBeTruthy()
    for (const c of CACHE_MISS_CAUSES) expect(MISS_CAUSE_LABEL[c]).toBeTruthy()
  })

  it('says plainly what a node that is not current means for agents', () => {
    expect(statusNotice({ status: 'CURRENT', trust: 'VERIFIED' })).toBeNull()
    expect(statusNotice({ status: 'CURRENT', trust: 'AGENT_NOTE' })?.text).toContain('unverified agent note')
    expect(statusNotice({ status: 'STALE', trust: 'VERIFIED' })?.text).toContain('changed since it was recorded')
    expect(statusNotice({ status: 'CONFLICTED', trust: 'INFERRED' })).toMatchObject({ tone: 'danger' })
    expect(statusNotice({ status: 'SUPERSEDED', trust: 'INFERRED' })?.text).toContain('Kept as history')
    expect(statusNotice({ status: 'PROPOSED', trust: 'AGENT_NOTE' })?.text).toContain('not yet approved')
  })

  it('reads a relation in the direction it is seen from, and groups relations by that reading', () => {
    expect(edgeLabel('TESTED_BY', 'out')).toBe('Tested by')
    expect(edgeLabel('TESTED_BY', 'in')).toBe('Tests')
    expect(edgeLabel('SUPERSEDES', 'in')).toBe('Superseded by')
    const node = (title: string) => ({ id: title, title }) as ContextNode
    const groups = groupRelations(
      [{ edge: { type: 'TESTED_BY' as const }, node: node('a.test.ts') }, { edge: { type: 'DEPENDS_ON' as const }, node: node('core') }, { edge: { type: 'TESTED_BY' as const }, node: node('b.test.ts') }],
      [{ edge: { type: 'DEPENDS_ON' as const }, node: node('ui') }],
    )
    expect(groups.map((g) => `${g.label}:${g.items.map((i) => i.node.title).join(',')}`)).toEqual(['Depended on by:ui', 'Depends on:core', 'Tested by:a.test.ts,b.test.ts'])
  })

  it('shows shares as whole percentages and a dash when there is nothing to divide', () => {
    expect(percent(0.684)).toBe('68%')
    expect(percent(null)).toBe('—')
    expect(percent(Number.NaN)).toBe('—')
    expect(cacheReadShare({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
    expect(percent(cacheReadShare({ inputTokens: 12_185, cacheReadTokens: 185_527, cacheWriteTokens: 75_389 }))).toBe('68%')
  })
})
