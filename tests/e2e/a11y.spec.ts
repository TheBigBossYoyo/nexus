import { expect, test, type Page } from '@playwright/test'
import { closeApp, createRepo, invoke, launchApp, removeDir, tempDir } from './helpers'

/**
 * An automated accessibility check of every page, in both themes, on the built application. It runs in the page
 * and reads the rendered DOM and its computed styles; it uses no library. What it checks (WCAG 2.2 AA, the part a
 * machine can decide):
 *   4.1.2  every control has an accessible name; a switch states its state, a tab its selection;
 *   1.3.1  every id an ARIA attribute points at exists; a form control's label points at it;
 *   2.4.3  no positive tab index;
 *   2.4.2, 3.1.1  the window has a title and the document a language;
 *   1.4.3  text contrast of at least 4.5:1 (3:1 for large text), computed from the rendered colours;
 *   1.4.11 the edge of a text field, a select and a switch at least 3:1 against what it sits on.
 * It does not replace a person with a screen reader: it cannot judge whether a name is a good one.
 */
interface Finding {
  rule: string
  where: string
  detail: string
}

async function audit(page: Page): Promise<Finding[]> {
  return page.evaluate(() => {
    const findings: { rule: string; where: string; detail: string }[] = []
    const visible = (el: Element): boolean => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && !el.closest('[aria-hidden="true"]') && !el.closest('[hidden]')
    }
    const where = (el: Element): string => {
      const id = el.getAttribute('data-testid') ?? el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''} "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)}"`
    }
    const byId = (ids: string | null): Element[] => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null)
    const nameOf = (el: Element): string => {
      const labelled = byId(el.getAttribute('aria-labelledby')).map((e) => e.textContent ?? '').join(' ').trim()
      if (labelled) return labelled
      const aria = el.getAttribute('aria-label')?.trim()
      if (aria) return aria
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const label = [...(el.labels ?? [])].map((l) => l.textContent ?? '').join(' ').trim()
        if (label) return label
        if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button') && el.value) return el.value
        return el.getAttribute('title')?.trim() ?? el.getAttribute('placeholder')?.trim() ?? ''
      }
      return (el.textContent ?? '').trim() || (el.getAttribute('title')?.trim() ?? '')
    }

    // 4.1.2: names and states.
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=switch], [role=tab], [role=checkbox], [role=link], [role=menuitem]')) {
      if (!visible(el)) continue
      if (!nameOf(el)) findings.push({ rule: '4.1.2 name', where: where(el), detail: 'no accessible name' })
      const role = el.getAttribute('role')
      if ((role === 'switch' || role === 'checkbox') && !el.hasAttribute('aria-checked')) findings.push({ rule: '4.1.2 state', where: where(el), detail: `${role} without aria-checked` })
      if (role === 'tab' && !el.hasAttribute('aria-selected')) findings.push({ rule: '4.1.2 state', where: where(el), detail: 'tab without aria-selected' })
    }
    // 1.3.1: references.
    for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const el of document.querySelectorAll(`[${attribute}]`)) {
        if (!visible(el)) continue
        const ids = (el.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean)
        // A collapsed region may not be rendered: what it controls exists once it is expanded.
        if (attribute === 'aria-controls' && el.getAttribute('aria-expanded') === 'false') continue
        if (attribute === 'aria-controls' && el.getAttribute('aria-selected') === 'false') continue
        for (const id of ids) if (!document.getElementById(id)) findings.push({ rule: '1.3.1 reference', where: where(el), detail: `${attribute} names "${id}", which does not exist` })
      }
    }
    for (const label of document.querySelectorAll('label[for]')) {
      if (visible(label) && !document.getElementById(label.getAttribute('for') ?? '')) findings.push({ rule: '1.3.1 label', where: where(label), detail: 'label for a control that does not exist' })
    }
    // 2.4.3
    for (const el of document.querySelectorAll('[tabindex]')) {
      if (Number(el.getAttribute('tabindex')) > 0) findings.push({ rule: '2.4.3 tab order', where: where(el), detail: 'positive tabindex' })
    }
    // 2.4.2, 3.1.1
    if (!document.title.trim()) findings.push({ rule: '2.4.2 title', where: 'document', detail: 'no title' })
    if (!document.documentElement.lang) findings.push({ rule: '3.1.1 language', where: 'document', detail: 'no lang' })

    // Colours.
    const parse = (value: string): [number, number, number, number] | null => {
      const probe = document.createElement('canvas').getContext('2d')
      if (!probe) return null
      probe.fillStyle = '#000'
      probe.fillStyle = value
      const canvas = probe.canvas
      canvas.width = canvas.height = 1
      probe.clearRect(0, 0, 1, 1)
      probe.fillStyle = value
      probe.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
      return [r ?? 0, g ?? 0, b ?? 0, (a ?? 255) / 255]
    }
    const over = (top: [number, number, number, number], bottom: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => Math.round(top[i]! * top[3] + bottom[i]! * (1 - top[3]))) as [number, number, number]
    /** The colour behind an element: every background from the page up to it, composed. Null when an image is involved. */
    const backdrop = (el: Element): [number, number, number] | null => {
      const chain: Element[] = []
      for (let node: Element | null = el; node; node = node.parentElement) chain.unshift(node)
      let colour: [number, number, number] = [255, 255, 255]
      for (const node of chain) {
        const style = getComputedStyle(node)
        if (style.backgroundImage && style.backgroundImage !== 'none') return null
        const bg = parse(style.backgroundColor)
        if (bg && bg[3] > 0) colour = over(bg, colour)
      }
      return colour
    }
    const luminance = ([r, g, b]: [number, number, number]): number => {
      const channel = (v: number): number => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const ratio = (a: [number, number, number], b: [number, number, number]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
      return (hi + 0.05) / (lo + 0.05)
    }
    const opacityOf = (el: Element): number => {
      let o = 1
      for (let node: Element | null = el; node; node = node.parentElement) o *= Number(getComputedStyle(node).opacity)
      return o
    }
    const inactive = (el: Element): boolean => el.closest('[disabled], [aria-disabled="true"], fieldset[disabled]') !== null

    // 1.4.3: every element that holds text of its own.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const seen = new Set<Element>()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (!el || seen.has(el) || !(node.textContent ?? '').trim()) continue
      seen.add(el)
      if (!visible(el) || inactive(el) || el.closest('option')) continue
      const style = getComputedStyle(el)
      const fg = parse(style.color)
      const bg = backdrop(el)
      if (!fg || !bg) continue
      const alpha = fg[3] * opacityOf(el)
      const shown = over([fg[0], fg[1], fg[2], alpha], bg)
      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
      const r = ratio(shown, bg)
      if (r < (large ? 3 : 4.5) - 0.05) findings.push({ rule: '1.4.3 contrast', where: where(el), detail: `${r.toFixed(2)}:1 (rgb ${shown.join(',')} on ${bg.join(',')})` })
    }
    // 1.4.11: the edge of the controls a user must find.
    for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [role=switch]')) {
      if (!visible(el) || inactive(el)) continue
      const style = getComputedStyle(el)
      const behind = el.parentElement ? backdrop(el.parentElement) : null
      const border = parse(style.borderTopColor)
      const fill = backdrop(el)
      if (!behind || !border || !fill) continue
      const edge = Math.max(parseFloat(style.borderTopWidth) > 0 ? ratio(over(border, behind), behind) : 0, ratio(fill, behind))
      if (edge < 3 - 0.05) findings.push({ rule: '1.4.11 control edge', where: where(el), detail: `${edge.toFixed(2)}:1 against its surroundings` })
    }
    return findings
  })
}

const VIEWS = ['home', 'projects', 'run', 'programs', 'workspaces', 'agents', 'arena', 'policy', 'usage', 'providers', 'director', 'performance', 'intelligence', 'knowledge', 'control', 'overnight', 'activity', 'memory', 'settings'] as const

test.describe('accessibility, automated', () => {
  const dirs: string[] = []
  test.afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir)
  })

  test('every page, in the light and the dark theme, with a project and a finished mission', async () => {
    test.setTimeout(600_000)
    const repo = createRepo()
    const dataDir = tempDir('a11y')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await page.getByTestId('nav-projects').click()
      await page.getByTestId('open-project').click()
      await expect(page.getByTestId('project-detail')).toBeVisible()
      const project = (await invoke(page, 'projects.list', {}))[0]
      if (!project) throw new Error('no project')
      const run = await invoke(page, 'runs.create', { projectId: project.id, mode: 'build', preset: 'balanced', prompt: 'Add a small module.', compilationMode: 'EXACT', requirePlanApproval: false })
      await expect.poll(async () => (await invoke(page, 'runs.get', { runId: run.id })).run.state, { timeout: 150_000, intervals: [500] }).toMatch(/completed|failed|paused/)
      // A Director request that waits and a saved escalation, so that the Director page shows its records.
      await invoke(page, 'director.invoke', { projectId: project.id, objective: 'Should the next change be developed first?', level: 2 })
      await invoke(page, 'director.escalate', { projectId: project.id, objective: 'Review the plan before it starts.', level: 3, reasons: ['Two reviewers disagree'] })

      const all: (Finding & { view: string; theme: string })[] = []
      const visited = new Set<string>()
      for (const theme of ['light', 'dark'] as const) {
        const settings = await invoke(page, 'settings.get', {})
        await invoke(page, 'settings.update', { settings: { ...settings, appearance: { ...settings.appearance, theme } } })
        await page.reload()
        await expect(page.getByTestId('app-shell')).toBeVisible()
        for (const view of VIEWS) {
          const nav = page.getByTestId(`nav-${view}`)
          if ((await nav.count()) === 0) continue
          visited.add(view)
          await nav.click()
          await expect(page.getByTestId(`view-${view}`)).toBeVisible()
          if (view === 'director') await page.getByLabel('Project', { exact: true }).selectOption(project.id)
          if (view === 'projects') {
            const preview = page.getByTestId('compilation-preview')
            if ((await preview.count()) > 0 && !(await preview.evaluate((el) => (el as HTMLDetailsElement).open))) await preview.locator('summary').click()
          }
          await page.waitForTimeout(300)
          for (const finding of await audit(page)) all.push({ ...finding, view, theme })
        }
      }
      // The check has looked at every page there is, and it can see what it is meant to see: a control with no
      // name, a broken reference, a positive tab index and grey text on white are found when they are put there.
      expect([...visited].sort()).toEqual([...VIEWS].sort())
      await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.id = 'a11y-probe'
        probe.innerHTML =
          '<button data-testid="probe-nameless" style="width:20px;height:20px"></button>' +
          '<button data-testid="probe-reference" aria-describedby="no-such-id">Save</button>' +
          '<span data-testid="probe-tabindex" tabindex="3">x</span>' +
          '<p data-testid="probe-contrast" style="color:#c8c8c8;background:#ffffff">Pale text</p>' +
          '<input data-testid="probe-edge" aria-label="Probe" style="border:1px solid rgba(128,128,128,0.08);background:transparent" />'
        document.querySelector('main')?.prepend(probe)
      })
      const probed = (await audit(page)).filter((f) => f.where.includes('probe-'))
      expect(probed.map((f) => f.rule).sort(), JSON.stringify(probed)).toEqual(['1.3.1 reference', '1.4.11 control edge', '1.4.3 contrast', '2.4.3 tab order', '4.1.2 name'])
      await page.evaluate(() => document.getElementById('a11y-probe')?.remove())
      // One line per distinct finding, so that a failure reads as a list of what to fix.
      const lines = [...new Set(all.map((f) => `${f.rule} | ${f.theme} ${f.view} | ${f.where} | ${f.detail}`))]
      expect(lines, `${lines.length} accessibility finding(s):\n${lines.join('\n')}`).toEqual([])
    } finally {
      await closeApp(app)
    }
  })
})
