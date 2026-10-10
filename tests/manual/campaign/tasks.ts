// The eight tasks of the 0.7.0 / 0.7.1 real quality campaign, one per category. Each is a small repository
// (plain Node, `node --test`, no dependencies), a request, knowledge NEXUS holds about the project (approved
// project memory: both versions store it the same way), a hidden evaluation that is never in the repository,
// and a reference solution. The reference solution exists only to prove, without usage, that the hidden
// evaluation fails on the starting repository and can be passed (tests/integration/campaign-tasks.test.ts).
//
// This file imports nothing from NEXUS, so the same file runs against the 0.7.0 sources and the 0.7.1 sources.

export type Files = Record<string, string>

export interface Knowledge {
  title: string
  content: string
  filePaths: string[]
  source: 'user' | 'verifier' | 'architect'
}

export interface Repo {
  /** Directory name; also the workspace key. */
  name: string
  files: Files
  knowledge: Knowledge[]
  /** Hidden test files, written at the root of a scratch checkout of the result. */
  hidden: Files
  /** Reference solution: files that replace or add to the starting repository. */
  solution: Files
}

export interface CampaignTask {
  key: string
  category: string
  kind: 'mission' | 'program' | 'workspace'
  mode: 'build' | 'repair'
  prompt: string
  repos: Repo[]
  /** Program only. */
  successCriteria?: string[]
  /** Workspace only: the contract the first repository provides and the second copies. */
  contract?: { key: string; name: string; path: string; copyPath: string }
  /** Minutes before the harness stops waiting. */
  budgetMinutes: number
}

const pkg = (name: string): string => `${JSON.stringify({ name, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`
const HEAD = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n"

// ───────────────────────────── 1. localized bug ─────────────────────────────

const localized: CampaignTask = {
  key: 'localized-bug',
  category: 'localized bugfix',
  kind: 'mission',
  mode: 'build',
  budgetMinutes: 30,
  prompt: 'In long sessions the race state gets corrupted: after roughly eighteen hours of running, laps of a car appear out of driving order. Find the cause in the telemetry pipeline and fix it, with a test that fails before the fix.',
  repos: [{
    name: 'racedeck-lite',
    knowledge: [{ title: 'Packet sequence numbers wrap at 65535', content: 'The sender uses a 16-bit sequence counter, so seq wraps from 65535 to 0 about every 18 hours at one packet per second. Ordering by seq alone is wrong across a wrap; the session clock is monotonic and is the reliable order.', filePaths: ['src/telemetry/order.js'], source: 'user' }],
    files: {
      'package.json': pkg('racedeck-lite'),
      'README.md': '# RaceDeck Lite\n\nA small telemetry pipeline: packets come in, are ordered, and become race state.\n',
      'src/telemetry/packet.js': '/** A telemetry packet: { seq, clock, lap, car }. `seq` is a 16-bit counter set by the sender. `clock` is the session clock in milliseconds. */\nexport function makePacket(seq, clock, lap, car = 1) {\n  return { seq: seq & 0xffff, clock, lap, car }\n}\n',
      'src/telemetry/order.js': '/** Orders the packets of one batch before they are applied to the race state. */\nexport function orderPackets(packets) {\n  return [...packets].sort((a, b) => a.seq - b.seq)\n}\n',
      'src/telemetry/state.js': "import { orderPackets } from './order.js'\n\n/** Applies a batch of packets and returns the laps of each car in the order they were driven. */\nexport function applyBatch(state, packets) {\n  const next = { laps: { ...state.laps } }\n  for (const p of orderPackets(packets)) {\n    next.laps[p.car] = [...(next.laps[p.car] ?? []), p.lap]\n  }\n  return next\n}\n\nexport const emptyState = () => ({ laps: {} })\n",
      'src/telemetry/order.test.js': `${HEAD}import { orderPackets } from './order.js'\nimport { makePacket } from './packet.js'\n\ntest('orders packets by sequence number', () => {\n  const out = orderPackets([makePacket(3, 300, 3), makePacket(1, 100, 1), makePacket(2, 200, 2)])\n  assert.deepEqual(out.map((p) => p.lap), [1, 2, 3])\n})\n`,
      'src/strategy/pace.js': '/** Average lap delta of a car over its last laps. Unrelated to packet ordering. */\nexport function pace(laps) {\n  if (laps.length < 2) return 0\n  return (laps[laps.length - 1] - laps[0]) / (laps.length - 1)\n}\n',
      'src/strategy/pace.test.js': `${HEAD}import { pace } from './pace.js'\n\ntest('pace of evenly spaced laps', () => {\n  assert.equal(pace([1, 2, 3]), 1)\n})\n`,
    },
    hidden: {
      'hidden.test.js': `${HEAD}import { applyBatch, emptyState } from './src/telemetry/state.js'\nimport { makePacket } from './src/telemetry/packet.js'\n\ntest('laps stay in driving order when the sequence counter wraps', () => {\n  const batch = [makePacket(65534, 1000, 10), makePacket(65535, 2000, 11), makePacket(65536, 3000, 12), makePacket(65537, 4000, 13)]\n  const shuffled = [batch[2], batch[0], batch[3], batch[1]]\n  assert.deepEqual(applyBatch(emptyState(), shuffled).laps[1], [10, 11, 12, 13])\n})\n\ntest('packets of an ordinary batch are still ordered', () => {\n  const batch = [makePacket(7, 700, 3), makePacket(5, 500, 1), makePacket(6, 600, 2)]\n  assert.deepEqual(applyBatch(emptyState(), batch).laps[1], [1, 2, 3])\n})\n`,
    },
    solution: {
      'src/telemetry/order.js': '/** Orders the packets of one batch by the session clock: the 16-bit sequence counter wraps. */\nexport function orderPackets(packets) {\n  return [...packets].sort((a, b) => a.clock - b.clock || a.seq - b.seq)\n}\n',
    },
  }],
}

// ───────────────────────────── 2. cross-module bug ─────────────────────────────

const crossModule: CampaignTask = {
  key: 'cross-module-bug',
  category: 'cross-module bug',
  kind: 'mission',
  mode: 'build',
  budgetMinutes: 30,
  prompt: 'Customers report that the total printed on an invoice sometimes differs by a cent from the total the cart showed at checkout, for example three items at 0.35 with the 15% member discount and 20% tax. Find out why the cart and the invoice disagree, make both follow the rules in docs/MONEY.md for every order, and add regression tests.',
  repos: [{
    name: 'shopfront',
    knowledge: [
      { title: 'Money is integer cents', content: 'All amounts are integer cents from the first step. A total is never computed in floating point and rounded at the end; the discount and the tax are each rounded once, half up, on the order, never per line.', filePaths: ['src/money.js', 'docs/MONEY.md'], source: 'architect' },
      { title: 'Invoice totals must equal cart totals', content: 'The invoice module and the cart module compute the same order total independently. An earlier incident came from the two rounding at different steps; they must share one calculation.', filePaths: ['src/cart/total.js', 'src/invoice/invoice.js'], source: 'verifier' },
    ],
    files: {
      'package.json': pkg('shopfront'),
      'README.md': '# Shopfront\n\nCart and invoice calculations. The money rules are in docs/MONEY.md.\n',
      'docs/MONEY.md': '# Money rules\n\n1. Every amount is an integer number of cents. Prices are given in cents.\n2. A line is `priceCents * quantity`.\n3. The subtotal is the sum of the lines.\n4. The discount is `subtotal * discountPercent / 100`, rounded half up to a whole cent, computed once on the subtotal.\n5. The tax is `(subtotal - discount) * taxPercent / 100`, rounded half up to a whole cent, computed once.\n6. The total is `subtotal - discount + tax`.\n\nThe cart and the invoice must report the same subtotal, discount, tax and total for the same order.\n',
      'src/money.js': '/** Rounds half up to a whole number of cents. */\nexport function roundCents(value) {\n  return Math.floor(value + 0.5)\n}\n\nexport function formatCents(cents) {\n  return (cents / 100).toFixed(2)\n}\n',
      'src/cart/total.js': "/** The total of a cart in cents. `order` is { items: [{ priceCents, quantity }], discountPercent, taxPercent }. */\nexport function cartTotal(order) {\n  let total = 0\n  for (const item of order.items) {\n    const line = (item.priceCents / 100) * item.quantity\n    total += line * (1 - order.discountPercent / 100) * (1 + order.taxPercent / 100)\n  }\n  return Math.round(total * 100)\n}\n",
      'src/cart/total.test.js': `${HEAD}import { cartTotal } from './total.js'\n\ntest('a cart without discount or tax is the sum of its lines', () => {\n  assert.equal(cartTotal({ items: [{ priceCents: 250, quantity: 2 }, { priceCents: 100, quantity: 1 }], discountPercent: 0, taxPercent: 0 }), 600)\n})\n`,
      'src/invoice/invoice.js': "import { formatCents, roundCents } from '../money.js'\n\n/** The invoice of an order: its lines and its totals, in cents, with a printable total. */\nexport function buildInvoice(order) {\n  const lines = order.items.map((item) => {\n    const gross = item.priceCents * item.quantity\n    const discount = roundCents((gross * order.discountPercent) / 100)\n    const tax = roundCents(((gross - discount) * order.taxPercent) / 100)\n    return { gross, discount, tax, net: gross - discount + tax }\n  })\n  const sum = (key) => lines.reduce((n, l) => n + l[key], 0)\n  const total = sum('net')\n  return { lines, subtotal: sum('gross'), discount: sum('discount'), tax: sum('tax'), total, printed: formatCents(total) }\n}\n",
      'src/invoice/invoice.test.js': `${HEAD}import { buildInvoice } from './invoice.js'\n\ntest('an invoice without discount or tax is the sum of its lines', () => {\n  const invoice = buildInvoice({ items: [{ priceCents: 250, quantity: 2 }, { priceCents: 100, quantity: 1 }], discountPercent: 0, taxPercent: 0 })\n  assert.equal(invoice.total, 600)\n  assert.equal(invoice.printed, '6.00')\n})\n`,
    },
    hidden: {
      'hidden.test.js': `${HEAD}import { cartTotal } from './src/cart/total.js'\nimport { buildInvoice } from './src/invoice/invoice.js'\n\nconst half = (v) => Math.floor(v + 0.5)\nfunction expected(order) {\n  const subtotal = order.items.reduce((n, i) => n + i.priceCents * i.quantity, 0)\n  const discount = half((subtotal * order.discountPercent) / 100)\n  const tax = half(((subtotal - discount) * order.taxPercent) / 100)\n  return { subtotal, discount, tax, total: subtotal - discount + tax }\n}\nconst ORDERS = [\n  { items: [{ priceCents: 35, quantity: 3 }], discountPercent: 15, taxPercent: 20 },\n  { items: [{ priceCents: 35, quantity: 1 }, { priceCents: 35, quantity: 1 }, { priceCents: 35, quantity: 1 }], discountPercent: 15, taxPercent: 20 },\n  { items: [{ priceCents: 10, quantity: 3 }, { priceCents: 5, quantity: 1 }], discountPercent: 15, taxPercent: 0 },\n  { items: [{ priceCents: 199, quantity: 7 }, { priceCents: 1, quantity: 3 }, { priceCents: 333, quantity: 3 }], discountPercent: 12.5, taxPercent: 7.7 },\n  { items: [{ priceCents: 1, quantity: 1 }, { priceCents: 1, quantity: 1 }, { priceCents: 1, quantity: 1 }], discountPercent: 50, taxPercent: 50 },\n  { items: [{ priceCents: 250, quantity: 2 }, { priceCents: 100, quantity: 1 }], discountPercent: 0, taxPercent: 0 },\n  { items: [], discountPercent: 10, taxPercent: 20 },\n]\n\nfor (const [i, order] of ORDERS.entries()) {\n  test('order ' + i + ': the cart follows the money rules', () => {\n    assert.equal(cartTotal(order), expected(order).total)\n  })\n  test('order ' + i + ': the invoice follows the money rules and equals the cart', () => {\n    const invoice = buildInvoice(order)\n    const want = expected(order)\n    assert.equal(invoice.subtotal, want.subtotal)\n    assert.equal(invoice.discount, want.discount)\n    assert.equal(invoice.tax, want.tax)\n    assert.equal(invoice.total, want.total)\n    assert.equal(invoice.total, cartTotal(order))\n    assert.equal(invoice.printed, (want.total / 100).toFixed(2))\n  })\n}\n`,
    },
    solution: {
      'src/money.js': '/** Rounds half up to a whole number of cents. */\nexport function roundCents(value) {\n  return Math.floor(value + 0.5)\n}\n\nexport function formatCents(cents) {\n  return (cents / 100).toFixed(2)\n}\n\n/** The one calculation of an order (docs/MONEY.md): cents throughout, discount and tax rounded once. */\nexport function orderTotals(order) {\n  const subtotal = order.items.reduce((n, item) => n + item.priceCents * item.quantity, 0)\n  const discount = roundCents((subtotal * order.discountPercent) / 100)\n  const tax = roundCents(((subtotal - discount) * order.taxPercent) / 100)\n  return { subtotal, discount, tax, total: subtotal - discount + tax }\n}\n',
      'src/cart/total.js': "import { orderTotals } from '../money.js'\n\n/** The total of a cart in cents. */\nexport function cartTotal(order) {\n  return orderTotals(order).total\n}\n",
      'src/invoice/invoice.js': "import { formatCents, orderTotals } from '../money.js'\n\n/** The invoice of an order: its lines and its totals, in cents, with a printable total. */\nexport function buildInvoice(order) {\n  const lines = order.items.map((item) => ({ gross: item.priceCents * item.quantity }))\n  const totals = orderTotals(order)\n  return { lines, ...totals, printed: formatCents(totals.total) }\n}\n",
    },
  }],
}

// ───────────────────────────── 3. normal feature ─────────────────────────────

const feature: CampaignTask = {
  key: 'feature',
  category: 'normal feature',
  kind: 'mission',
  mode: 'build',
  budgetMinutes: 30,
  prompt: 'Add a CSV export of the address book: `exportCsv(contacts)` in src/export/csv.js returns the file content as a string with the columns name, email and phone, in that order, with a header row. A missing value is an empty field. Follow the export conventions of this project (docs/CONVENTIONS.md). Include tests.',
  repos: [{
    name: 'addressbook',
    knowledge: [
      { title: 'Export files open in spreadsheets', content: 'Every exported text file starts with a UTF-8 byte order mark and uses CRLF line endings, including after the last row, because the support team opens exports in a spreadsheet on Windows. An export without the mark showed broken accents.', filePaths: ['docs/CONVENTIONS.md', 'src/export/json.js'], source: 'user' },
    ],
    files: {
      'package.json': pkg('addressbook'),
      'README.md': '# Address book\n\nContacts and their exports. Conventions: docs/CONVENTIONS.md.\n',
      'docs/CONVENTIONS.md': '# Conventions\n\n## Exports\n\n- An exported text file starts with a UTF-8 byte order mark (U+FEFF).\n- Lines end with CRLF, including the last line.\n- CSV follows RFC 4180: a field that contains a comma, a double quote, a carriage return or a line feed is enclosed in double quotes, and a double quote inside it is doubled. Other fields are not quoted.\n- Contacts are exported in the order given.\n',
      'src/contacts.js': "/** A contact is { name, email, phone }. `phone` may be missing. */\nexport function makeContact(name, email, phone) {\n  return phone === undefined ? { name, email } : { name, email, phone }\n}\n",
      'src/export/json.js': "const BOM = '\\uFEFF'\n\n/** The contacts as a JSON document, one contact per line. */\nexport function exportJson(contacts) {\n  const rows = contacts.map((c) => JSON.stringify({ name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '' }))\n  return BOM + ['[', rows.join(',\\r\\n'), ']'].join('\\r\\n') + '\\r\\n'\n}\n",
      'src/export/json.test.js': `${HEAD}import { exportJson } from './json.js'\n\ntest('the JSON export starts with the byte order mark and parses', () => {\n  const out = exportJson([{ name: 'Ada', email: 'ada@example.com' }])\n  assert.equal(out.charCodeAt(0), 0xfeff)\n  assert.deepEqual(JSON.parse(out.slice(1)), [{ name: 'Ada', email: 'ada@example.com', phone: '' }])\n})\n`,
    },
    hidden: {
      'hidden.test.js': `${HEAD}import { exportCsv } from './src/export/csv.js'\n\nconst BOM = String.fromCharCode(0xfeff)\n\ntest('header row, columns in order, byte order mark and CRLF after every line', () => {\n  const out = exportCsv([{ name: 'Ada', email: 'ada@example.com', phone: '123' }])\n  assert.equal(out, BOM + 'name,email,phone\\r\\nAda,ada@example.com,123\\r\\n')\n})\n\ntest('an empty address book is the header alone', () => {\n  assert.equal(exportCsv([]), BOM + 'name,email,phone\\r\\n')\n})\n\ntest('missing values are empty fields', () => {\n  const out = exportCsv([{ name: 'Bo', email: 'bo@example.com' }, { name: 'Cy', email: null, phone: undefined }])\n  assert.equal(out, BOM + 'name,email,phone\\r\\nBo,bo@example.com,\\r\\nCy,,\\r\\n')\n})\n\ntest('fields with a comma, a quote or a line break are quoted, and quotes are doubled', () => {\n  const out = exportCsv([{ name: 'Lovelace, Ada', email: 'a"b@example.com', phone: 'line1\\nline2' }, { name: 'carriage\\rreturn', email: 'plain', phone: ' spaced ' }])\n  assert.equal(out, BOM + 'name,email,phone\\r\\n"Lovelace, Ada","a""b@example.com","line1\\nline2"\\r\\n"carriage\\rreturn",plain, spaced \\r\\n')\n})\n\ntest('contacts keep the order given', () => {\n  const out = exportCsv([{ name: 'Zed', email: 'z' }, { name: 'Amy', email: 'a' }])\n  assert.ok(out.indexOf('Zed') < out.indexOf('Amy'))\n})\n`,
    },
    solution: {
      'src/export/csv.js': "const BOM = '\\uFEFF'\nconst COLUMNS = ['name', 'email', 'phone']\n\nfunction field(value) {\n  const text = value === null || value === undefined ? '' : String(value)\n  return /[\",\\r\\n]/.test(text) ? '\"' + text.replaceAll('\"', '\"\"') + '\"' : text\n}\n\n/** The contacts as CSV (RFC 4180), following docs/CONVENTIONS.md. */\nexport function exportCsv(contacts) {\n  const rows = [COLUMNS.join(','), ...contacts.map((c) => COLUMNS.map((k) => field(c[k])).join(','))]\n  return BOM + rows.map((r) => r + '\\r\\n').join('')\n}\n",
    },
  }],
}

// ───────────────────────────── 4. refactor ─────────────────────────────

const HANDLER = (name: string, extra: string, body: string): string =>
  `/** ${name}: validates its input and returns { ok: true, value } or { ok: false, error }. */\nexport function ${name}(input) {\n  if (typeof input.email !== 'string' || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(input.email.trim())) return { ok: false, error: 'email: not a valid address' }\n  if (input.email.trim().length > 254) return { ok: false, error: 'email: longer than 254 characters' }\n  if (typeof input.name !== 'string' || input.name.trim() === '') return { ok: false, error: 'name: required' }\n  if (input.name.trim().length > 80) return { ok: false, error: 'name: longer than 80 characters' }\n${extra}  return { ok: true, value: ${body} }\n}\n`

const refactor: CampaignTask = {
  key: 'refactor',
  category: 'refactor',
  kind: 'mission',
  mode: 'build',
  budgetMinutes: 30,
  prompt: 'The three handlers in src/handlers (createUser, updateUser, inviteUser) each carry their own copy of the email and name validation. Refactor: move the validation into one module, src/validation.js, exporting `validateEmail(value)` and `validateName(value)`, each returning null when the value is valid and the error message otherwise, and make all three handlers use it. Behaviour must not change: the same inputs give the same results, error messages included. Keep the existing tests passing and add tests for the new module.',
  repos: [{
    name: 'accounts',
    knowledge: [
      { title: 'Handler results are a public contract', content: 'Clients match on the exact error strings the handlers return (for example "email: not a valid address"). Changing the wording or the order in which problems are reported is a breaking change. The email is checked before the name.', filePaths: ['src/handlers/createUser.js', 'src/handlers/updateUser.js', 'src/handlers/inviteUser.js'], source: 'user' },
    ],
    files: {
      'package.json': pkg('accounts'),
      'README.md': '# Accounts\n\nRequest handlers for user accounts. Each returns { ok, value } or { ok, error }.\n',
      'src/handlers/createUser.js': HANDLER('createUser', '', "{ email: input.email.trim().toLowerCase(), name: input.name.trim(), role: 'member' }"),
      'src/handlers/updateUser.js': HANDLER('updateUser', "  if (typeof input.id !== 'string' || input.id === '') return { ok: false, error: 'id: required' }\n", '{ id: input.id, email: input.email.trim().toLowerCase(), name: input.name.trim() }'),
      'src/handlers/inviteUser.js': HANDLER('inviteUser', "  if (input.role !== 'member' && input.role !== 'admin') return { ok: false, error: 'role: must be member or admin' }\n", '{ email: input.email.trim().toLowerCase(), name: input.name.trim(), role: input.role, invited: true }'),
      'src/handlers/handlers.test.js': `${HEAD}import { createUser } from './createUser.js'\nimport { updateUser } from './updateUser.js'\nimport { inviteUser } from './inviteUser.js'\n\ntest('a valid user is created with a normalised email', () => {\n  assert.deepEqual(createUser({ email: ' Ada@Example.com ', name: ' Ada ' }), { ok: true, value: { email: 'ada@example.com', name: 'Ada', role: 'member' } })\n})\n\ntest('an invalid email is reported', () => {\n  assert.deepEqual(updateUser({ id: '1', email: 'nope', name: 'Ada' }), { ok: false, error: 'email: not a valid address' })\n})\n\ntest('an invitation needs a known role', () => {\n  assert.deepEqual(inviteUser({ email: 'a@b.co', name: 'Ada', role: 'owner' }), { ok: false, error: 'role: must be member or admin' })\n})\n`,
    },
    hidden: {
      'hidden.test.js': `${HEAD}import { readFileSync } from 'node:fs'\nimport { createUser } from './src/handlers/createUser.js'\nimport { updateUser } from './src/handlers/updateUser.js'\nimport { inviteUser } from './src/handlers/inviteUser.js'\nimport { validateEmail, validateName } from './src/validation.js'\n\nconst long = (n) => 'x'.repeat(n)\nconst CASES = [\n  [{ email: 'a@b.co', name: 'Ada' }, null],\n  [{ email: ' a@b.co ', name: ' Ada ' }, null],\n  [{ email: 'nope', name: 'Ada' }, 'email: not a valid address'],\n  [{ email: 42, name: 'Ada' }, 'email: not a valid address'],\n  [{ name: 'Ada' }, 'email: not a valid address'],\n  [{ email: 'a b@c.de', name: 'Ada' }, 'email: not a valid address'],\n  [{ email: long(250) + '@b.co', name: 'Ada' }, 'email: longer than 254 characters'],\n  [{ email: 'a@b.co', name: '   ' }, 'name: required'],\n  [{ email: 'a@b.co' }, 'name: required'],\n  [{ email: 'a@b.co', name: long(81) }, 'name: longer than 80 characters'],\n  [{ email: 'nope', name: '' }, 'email: not a valid address'],\n]\n\ntest('createUser gives the same results as before', () => {\n  for (const [input, error] of CASES) {\n    const out = createUser(input)\n    if (error) assert.deepEqual(out, { ok: false, error })\n    else assert.deepEqual(out, { ok: true, value: { email: 'a@b.co', name: 'Ada', role: 'member' } })\n  }\n})\n\ntest('updateUser gives the same results as before, the id checked last', () => {\n  for (const [input, error] of CASES) {\n    const out = updateUser({ ...input, id: '7' })\n    if (error) assert.deepEqual(out, { ok: false, error })\n    else assert.deepEqual(out, { ok: true, value: { id: '7', email: 'a@b.co', name: 'Ada' } })\n  }\n  assert.deepEqual(updateUser({ email: 'a@b.co', name: 'Ada' }), { ok: false, error: 'id: required' })\n  assert.deepEqual(updateUser({ email: 'nope', name: 'Ada' }), { ok: false, error: 'email: not a valid address' })\n})\n\ntest('inviteUser gives the same results as before, the role checked last', () => {\n  for (const [input, error] of CASES) {\n    const out = inviteUser({ ...input, role: 'admin' })\n    if (error) assert.deepEqual(out, { ok: false, error })\n    else assert.deepEqual(out, { ok: true, value: { email: 'a@b.co', name: 'Ada', role: 'admin', invited: true } })\n  }\n  assert.deepEqual(inviteUser({ email: 'a@b.co', name: 'Ada', role: 'owner' }), { ok: false, error: 'role: must be member or admin' })\n  assert.deepEqual(inviteUser({ email: 'a@b.co', name: '', role: 'owner' }), { ok: false, error: 'name: required' })\n})\n\ntest('the shared module returns null for a valid value and the message otherwise', () => {\n  assert.equal(validateEmail('a@b.co'), null)\n  assert.equal(validateEmail(' a@b.co '), null)\n  assert.equal(validateEmail('nope'), 'email: not a valid address')\n  assert.equal(validateEmail(undefined), 'email: not a valid address')\n  assert.equal(validateEmail(long(250) + '@b.co'), 'email: longer than 254 characters')\n  assert.equal(validateName('Ada'), null)\n  assert.equal(validateName('  '), 'name: required')\n  assert.equal(validateName(7), 'name: required')\n  assert.equal(validateName(long(81)), 'name: longer than 80 characters')\n})\n\ntest('the handlers use the shared module and no longer carry their own copy', () => {\n  for (const name of ['createUser', 'updateUser', 'inviteUser']) {\n    const source = readFileSync(new URL('./src/handlers/' + name + '.js', import.meta.url), 'utf8')\n    assert.match(source, /from\\s+['"]\\.\\.\\/validation\\.js['"]/, name + ' imports ../validation.js')\n    assert.ok(!source.includes('[^@'), name + ' still has its own email pattern')\n    assert.ok(!source.includes('longer than'), name + ' still has its own length messages')\n  }\n})\n`,
    },
    solution: {
      'src/validation.js': "/** Null when the value is a valid email address, the error message otherwise. */\nexport function validateEmail(value) {\n  if (typeof value !== 'string' || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(value.trim())) return 'email: not a valid address'\n  if (value.trim().length > 254) return 'email: longer than 254 characters'\n  return null\n}\n\n/** Null when the value is a valid name, the error message otherwise. */\nexport function validateName(value) {\n  if (typeof value !== 'string' || value.trim() === '') return 'name: required'\n  if (value.trim().length > 80) return 'name: longer than 80 characters'\n  return null\n}\n",
      'src/handlers/createUser.js': "import { validateEmail, validateName } from '../validation.js'\n\nexport function createUser(input) {\n  const error = validateEmail(input.email) ?? validateName(input.name)\n  if (error) return { ok: false, error }\n  return { ok: true, value: { email: input.email.trim().toLowerCase(), name: input.name.trim(), role: 'member' } }\n}\n",
      'src/handlers/updateUser.js': "import { validateEmail, validateName } from '../validation.js'\n\nexport function updateUser(input) {\n  const error = validateEmail(input.email) ?? validateName(input.name)\n  if (error) return { ok: false, error }\n  if (typeof input.id !== 'string' || input.id === '') return { ok: false, error: 'id: required' }\n  return { ok: true, value: { id: input.id, email: input.email.trim().toLowerCase(), name: input.name.trim() } }\n}\n",
      'src/handlers/inviteUser.js': "import { validateEmail, validateName } from '../validation.js'\n\nexport function inviteUser(input) {\n  const error = validateEmail(input.email) ?? validateName(input.name)\n  if (error) return { ok: false, error }\n  if (input.role !== 'member' && input.role !== 'admin') return { ok: false, error: 'role: must be member or admin' }\n  return { ok: true, value: { email: input.email.trim().toLowerCase(), name: input.name.trim(), role: input.role, invited: true } }\n}\n",
    },
  }],
}

// ───────────────────────────── 5. architecture ─────────────────────────────

const architecture: CampaignTask = {
  key: 'architecture',
  category: 'architecture task',
  kind: 'mission',
  mode: 'build',
  budgetMinutes: 35,
  prompt: 'Every new report format means editing the switch in src/export/index.js, and two teams now want to add formats of their own. Redesign the exporters so that a format is added without editing an existing file. The public interface of src/export/index.js becomes: `registerExporter(name, fn)` (fn takes the rows and returns a string; registering a name twice throws), `exportData(format, rows)` (an unknown format throws an Error whose message names the format and lists the known formats), and `listFormats()` (the registered names, sorted alphabetically). `json` and `csv` are registered by default and keep their current output. Record the decision as docs/adr/0001-exporter-registry.md with the sections Context, Decision and Consequences. Include tests.',
  repos: [{
    name: 'reports',
    knowledge: [
      { title: 'Report output is byte-stable', content: 'Downstream jobs compare report files byte for byte with the previous day. The json and csv output of exportData must not change by a single character when exporters are reorganised.', filePaths: ['src/export/index.js'], source: 'user' },
      { title: 'Architecture decisions are recorded', content: 'A change to a module boundary gets an ADR under docs/adr, numbered from 0001, with the sections Context, Decision and Consequences. Reviewers reject a structural change without one.', filePaths: ['docs/adr'], source: 'architect' },
    ],
    files: {
      'package.json': pkg('reports'),
      'README.md': '# Reports\n\nTurns rows (arrays of plain objects) into report files. Architecture decisions live in docs/adr.\n',
      'docs/adr/README.md': '# Architecture decision records\n\nOne file per decision, numbered from 0001: `NNNN-short-title.md` with the sections Context, Decision and Consequences.\n',
      'src/export/index.js': "/** Turns rows into a report. Every new format is another case here. */\nexport function exportData(format, rows) {\n  switch (format) {\n    case 'json':\n      return JSON.stringify(rows, null, 2) + '\\n'\n    case 'csv': {\n      if (rows.length === 0) return ''\n      const columns = Object.keys(rows[0])\n      const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => String(r[c] ?? '')).join(','))]\n      return lines.join('\\n') + '\\n'\n    }\n    default:\n      throw new Error('Unknown format')\n  }\n}\n",
      'src/export/index.test.js': `${HEAD}import { exportData } from './index.js'\n\nconst ROWS = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]\n\ntest('json output', () => {\n  assert.equal(exportData('json', ROWS), JSON.stringify(ROWS, null, 2) + '\\n')\n})\n\ntest('csv output', () => {\n  assert.equal(exportData('csv', ROWS), 'id,name\\n1,a\\n2,b\\n')\n})\n`,
    },
    hidden: {
      'hidden.test.js': `${HEAD}import { existsSync, readFileSync } from 'node:fs'\nimport { exportData, listFormats, registerExporter } from './src/export/index.js'\n\nconst ROWS = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]\n\ntest('json and csv are registered by default and their output is unchanged', () => {\n  assert.deepEqual(listFormats(), ['csv', 'json'])\n  assert.equal(exportData('json', ROWS), JSON.stringify(ROWS, null, 2) + '\\n')\n  assert.equal(exportData('csv', ROWS), 'id,name\\n1,a\\n2,b\\n')\n  assert.equal(exportData('csv', []), '')\n  assert.equal(exportData('csv', [{ id: 1, name: null }]), 'id,name\\n1,\\n')\n})\n\ntest('an unknown format names itself and the known formats', () => {\n  assert.throws(() => exportData('xml', ROWS), (e) => e instanceof Error && e.message.includes('xml') && e.message.includes('csv') && e.message.includes('json'))\n})\n\ntest('a format is added from outside, without touching the module', () => {\n  registerExporter('tsv', (rows) => rows.map((r) => Object.values(r).join('\\t')).join('\\n'))\n  assert.equal(exportData('tsv', ROWS), '1\\ta\\n2\\tb')\n  assert.deepEqual(listFormats(), ['csv', 'json', 'tsv'])\n  assert.throws(() => exportData('xml', ROWS), (e) => e.message.includes('tsv'))\n})\n\ntest('registering a name twice throws and keeps the first exporter', () => {\n  registerExporter('once', () => 'first')\n  assert.throws(() => registerExporter('once', () => 'second'))\n  assert.throws(() => registerExporter('json', () => 'hijacked'))\n  assert.equal(exportData('once', []), 'first')\n  assert.equal(exportData('json', []), '[]\\n')\n})\n\ntest('the decision is recorded with its three sections', () => {\n  const file = new URL('./docs/adr/0001-exporter-registry.md', import.meta.url)\n  assert.ok(existsSync(file), 'docs/adr/0001-exporter-registry.md exists')\n  const text = readFileSync(file, 'utf8')\n  for (const heading of ['Context', 'Decision', 'Consequences']) assert.match(text, new RegExp('^#+\\\\s*' + heading + '\\\\b', 'mi'), heading)\n  assert.ok(text.length > 300, 'the record says something')\n})\n`,
    },
    solution: {
      'src/export/registry.js': "const exporters = new Map()\n\nexport function registerExporter(name, fn) {\n  if (exporters.has(name)) throw new Error('An exporter named ' + name + ' is already registered')\n  exporters.set(name, fn)\n}\n\nexport function listFormats() {\n  return [...exporters.keys()].sort()\n}\n\nexport function exportData(format, rows) {\n  const fn = exporters.get(format)\n  if (!fn) throw new Error('Unknown format ' + format + '. Known formats: ' + listFormats().join(', '))\n  return fn(rows)\n}\n",
      'src/export/json.js': "import { registerExporter } from './registry.js'\n\nregisterExporter('json', (rows) => JSON.stringify(rows, null, 2) + '\\n')\n",
      'src/export/csv.js': "import { registerExporter } from './registry.js'\n\nregisterExporter('csv', (rows) => {\n  if (rows.length === 0) return ''\n  const columns = Object.keys(rows[0])\n  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => String(r[c] ?? '')).join(','))]\n  return lines.join('\\n') + '\\n'\n})\n",
      'src/export/index.js': "import './json.js'\nimport './csv.js'\n\nexport { exportData, listFormats, registerExporter } from './registry.js'\n",
      'docs/adr/0001-exporter-registry.md': '# 0001: Exporter registry\n\n## Context\n\nEvery report format was a case of one switch in src/export/index.js, so adding a format meant editing a file every team shares, and two teams now want formats of their own. Downstream jobs compare the json and csv output byte for byte.\n\n## Decision\n\nExporters register themselves by name in a registry (src/export/registry.js). src/export/index.js imports the built-in exporters and re-exports registerExporter, exportData and listFormats. A name can be registered once.\n\n## Consequences\n\nA format is a new file, or a call from outside the module; existing files are not edited. The output of json and csv is unchanged. An unknown format reports the known ones. Registration order is import order, so listFormats sorts.\n',
    },
  }],
}

// ───────────────────────────── 6. security ─────────────────────────────

const security: CampaignTask = {
  key: 'security',
  category: 'security-sensitive task',
  kind: 'mission',
  mode: 'build',
  budgetMinutes: 35,
  prompt: "A security review found that the static file handler lets a request read files outside the served directory. Fix src/static/resolve.js: `resolvePath(root, urlPath)` returns the absolute path of the requested file, which must be `root` itself or inside it, and otherwise throws an Error with `code` set to 'EFORBIDDEN'. The URL path is percent-decoded exactly once; malformed percent-encoding and a NUL character throw an Error with `code` 'EBADREQUEST'. A backslash is treated as a path separator. A request that stays inside the root is served even when it contains `..`. Add tests that cover the attacks you can think of.",
  repos: [{
    name: 'fileserver',
    knowledge: [
      { title: 'Sibling directories share a prefix with the web root', content: "The web root is deployed as /srv/www and the private uploads live next to it in /srv/www-private. A containment check that compares string prefixes without a separator lets /srv/www-private pass as inside /srv/www.", filePaths: ['src/static/resolve.js'], source: 'verifier' },
      { title: 'The server also runs on Windows', content: 'The file server is deployed on Windows hosts as well as Linux: a backslash in a request reaches the file system as a separator there, and paths must be compared after normalisation, not as the client wrote them.', filePaths: ['src/static/resolve.js'], source: 'user' },
    ],
    files: {
      'package.json': pkg('fileserver'),
      'README.md': '# File server\n\nServes the files of one directory. `resolvePath` maps a URL path to a file.\n',
      'src/static/resolve.js': "import { join } from 'node:path'\n\n/** Maps the path of a request to a file under `root`. */\nexport function resolvePath(root, urlPath) {\n  return join(root, decodeURIComponent(urlPath))\n}\n",
      'src/static/resolve.test.js': `${HEAD}import { join, resolve } from 'node:path'\nimport { resolvePath } from './resolve.js'\n\ntest('a plain path is a file under the root', () => {\n  const root = resolve('web')\n  assert.equal(resolvePath(root, '/index.html'), join(root, 'index.html'))\n})\n`,
    },
    hidden: {
      'hidden.test.js': `${HEAD}import { join, resolve, sep } from 'node:path'\nimport { resolvePath } from './src/static/resolve.js'\n\nconst root = resolve('srv', 'www')\nconst code = (c) => (e) => e instanceof Error && e.code === c\n\ntest('ordinary requests are served', () => {\n  assert.equal(resolvePath(root, '/index.html'), join(root, 'index.html'))\n  assert.equal(resolvePath(root, '/sub/file.txt'), join(root, 'sub', 'file.txt'))\n  assert.equal(resolvePath(root, '/a%20b.txt'), join(root, 'a b.txt'))\n  assert.equal(resolvePath(root, '/'), root)\n})\n\ntest('dot segments that stay inside the root are served', () => {\n  assert.equal(resolvePath(root, '/sub/../index.html'), join(root, 'index.html'))\n  assert.equal(resolvePath(root, '/sub/./file.txt'), join(root, 'sub', 'file.txt'))\n})\n\ntest('traversal out of the root is forbidden', () => {\n  for (const attack of ['/../secret', '/sub/../../secret', '/../../../../etc/passwd', '/..', '/sub/../..']) assert.throws(() => resolvePath(root, attack), code('EFORBIDDEN'), attack)\n})\n\ntest('encoded traversal is forbidden', () => {\n  for (const attack of ['/%2e%2e/secret', '/..%2fsecret', '/%2e%2e%2f%2e%2e%2fsecret', '/sub/%2E%2E/%2E%2E/secret']) assert.throws(() => resolvePath(root, attack), code('EFORBIDDEN'), attack)\n})\n\ntest('a backslash is a separator', () => {\n  for (const attack of ['/..\\\\secret', '\\\\..\\\\secret', '/sub\\\\..\\\\..\\\\secret', '/%5c..%5csecret']) assert.throws(() => resolvePath(root, attack), code('EFORBIDDEN'), attack)\n  assert.equal(resolvePath(root, '/sub\\\\file.txt'), join(root, 'sub', 'file.txt'))\n})\n\ntest('a sibling directory that shares the prefix of the root is outside it', () => {\n  assert.throws(() => resolvePath(root, '/../www-private/key.pem'), code('EFORBIDDEN'))\n  assert.throws(() => resolvePath(root, '/..' + '/www' + '-private'), code('EFORBIDDEN'))\n})\n\ntest('the path is decoded exactly once', () => {\n  // %252e%252e decodes to the literal name %2e%2e: a file inside the root, not a traversal.\n  assert.equal(resolvePath(root, '/%252e%252e/secret'), join(root, '%2e%2e', 'secret'))\n})\n\ntest('malformed encoding and NUL are bad requests', () => {\n  for (const bad of ['/%zz', '/%', '/a%2', '/%00', '/a%00.txt', '/a' + String.fromCharCode(0) + 'b']) assert.throws(() => resolvePath(root, bad), code('EBADREQUEST'), JSON.stringify(bad))\n})\n\ntest('the result is absolute and never leaves the root', () => {\n  for (const p of ['/x', '/a/b/c', '/a/../b', '/a//b']) {\n    const out = resolvePath(root, p)\n    assert.ok(out === root || out.startsWith(root + sep), out)\n  }\n})\n`,
    },
    solution: {
      'src/static/resolve.js': "import { resolve, sep } from 'node:path'\n\nfunction fail(code, message) {\n  const error = new Error(message)\n  error.code = code\n  return error\n}\n\n/** Maps the path of a request to a file that is `root` or inside it. */\nexport function resolvePath(root, urlPath) {\n  let decoded\n  try {\n    decoded = decodeURIComponent(urlPath)\n  } catch {\n    throw fail('EBADREQUEST', 'Malformed percent-encoding')\n  }\n  if (decoded.includes('\\0')) throw fail('EBADREQUEST', 'NUL character in path')\n  const base = resolve(root)\n  const relative = decoded.replaceAll('\\\\', '/').replace(/^\\/+/, '')\n  const target = resolve(base, relative)\n  if (target !== base && !target.startsWith(base + sep)) throw fail('EFORBIDDEN', 'Path leaves the served directory')\n  return target\n}\n",
    },
  }],
}

// ───────────────────────────── 7. program ─────────────────────────────

const program: CampaignTask = {
  key: 'program',
  category: 'Program-style task',
  kind: 'program',
  mode: 'build',
  budgetMinutes: 90,
  prompt: 'Build a small key-value store library in src/kv.js, in two milestones. Milestone one, the store: `createStore({ now })` returns a store with `set(key, value, { ttlMs })`, `get(key)`, `has(key)`, `delete(key)` and `size()`; `now` is an injectable clock returning milliseconds (default Date.now); a key set with ttlMs expires when the clock reaches the time it was set plus ttlMs, after which get returns undefined, has returns false and size does not count it; setting a key again replaces its value and its expiry. Milestone two, persistence, in src/persist.js: `save(store, file)` writes the live entries as JSON atomically (write a temporary file in the same directory, then rename it over the target) and `load(file, { now })` returns a store with the same entries, each keeping its absolute expiry time; an entry that has expired is neither saved nor loaded; loading a file that does not exist returns an empty store. Each milestone has tests.',
  successCriteria: ['src/kv.js exports createStore with set, get, has, delete and size, and expiry by an injectable clock', 'src/persist.js exports save and load; save is atomic; expiry survives a save and a load', 'node --test passes'],
  repos: [{
    name: 'kvlib',
    knowledge: [
      { title: 'Time is injected, never read directly', content: 'Library code takes its clock as an option (`now`, returning milliseconds) and never calls Date.now inside a function body other than as the default of that option, so tests control time without sleeping.', filePaths: ['src'], source: 'architect' },
      { title: 'Files are replaced atomically', content: 'A file another process may read is never written in place: write a temporary file in the same directory and rename it over the target, so a reader sees the old content or the new, never half.', filePaths: ['src'], source: 'user' },
    ],
    files: {
      'package.json': pkg('kvlib'),
      'README.md': '# kvlib\n\nA small key-value store library. Nothing is implemented yet.\n',
      'src/index.js': '// The library entry point. Nothing is implemented yet.\nexport {}\n',
      'src/index.test.js': `${HEAD}\ntest('the package loads', async () => {\n  assert.ok(await import('./index.js'))\n})\n`,
    },
    hidden: {
      'hidden.test.js': `${HEAD}import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { createStore } from './src/kv.js'\nimport { load, save } from './src/persist.js'\n\nfunction clock(start = 1000) {\n  let t = start\n  const now = () => t\n  now.advance = (ms) => { t += ms }\n  return now\n}\n\ntest('set, get, has, delete and size', () => {\n  const s = createStore({ now: clock() })\n  assert.equal(s.size(), 0)\n  s.set('a', 1)\n  s.set('b', { x: [1, 2] })\n  assert.equal(s.get('a'), 1)\n  assert.deepEqual(s.get('b'), { x: [1, 2] })\n  assert.equal(s.has('a'), true)\n  assert.equal(s.has('zz'), false)\n  assert.equal(s.get('zz'), undefined)\n  assert.equal(s.size(), 2)\n  s.delete('a')\n  assert.equal(s.has('a'), false)\n  assert.equal(s.size(), 1)\n})\n\ntest('a key expires when the clock reaches its time', () => {\n  const now = clock()\n  const s = createStore({ now })\n  s.set('t', 'v', { ttlMs: 100 })\n  s.set('forever', 'v')\n  now.advance(99)\n  assert.equal(s.get('t'), 'v')\n  assert.equal(s.size(), 2)\n  now.advance(1)\n  assert.equal(s.get('t'), undefined)\n  assert.equal(s.has('t'), false)\n  assert.equal(s.size(), 1)\n  now.advance(1_000_000)\n  assert.equal(s.get('forever'), 'v')\n})\n\ntest('setting a key again replaces its value and its expiry', () => {\n  const now = clock()\n  const s = createStore({ now })\n  s.set('k', 1, { ttlMs: 50 })\n  now.advance(40)\n  s.set('k', 2, { ttlMs: 50 })\n  now.advance(40)\n  assert.equal(s.get('k'), 2)\n  s.set('k', 3)\n  now.advance(10_000)\n  assert.equal(s.get('k'), 3)\n})\n\ntest('the default clock works without options', () => {\n  const s = createStore()\n  s.set('a', 1, { ttlMs: 60_000 })\n  assert.equal(s.get('a'), 1)\n})\n\ntest('save and load keep the entries and their absolute expiry', () => {\n  const dir = mkdtempSync(join(tmpdir(), 'kv-hidden-'))\n  const file = join(dir, 'store.json')\n  const now = clock()\n  const s = createStore({ now })\n  s.set('a', 1)\n  s.set('t', 'v', { ttlMs: 100 })\n  s.set('gone', 'x', { ttlMs: 10 })\n  now.advance(20)\n  save(s, file)\n  JSON.parse(readFileSync(file, 'utf8'))\n  assert.ok(!readFileSync(file, 'utf8').includes('gone'), 'an expired entry is not saved')\n  const later = clock(1000 + 20 + 50)\n  const loaded = load(file, { now: later })\n  assert.equal(loaded.get('a'), 1)\n  assert.equal(loaded.get('t'), 'v')\n  assert.equal(loaded.size(), 2)\n  later.advance(30)\n  assert.equal(loaded.get('t'), undefined, 'the expiry is the original absolute time')\n  assert.equal(loaded.get('a'), 1)\n})\n\ntest('an entry that expired between save and load is not loaded', () => {\n  const dir = mkdtempSync(join(tmpdir(), 'kv-hidden-'))\n  const file = join(dir, 'store.json')\n  const now = clock()\n  const s = createStore({ now })\n  s.set('t', 'v', { ttlMs: 100 })\n  save(s, file)\n  const loaded = load(file, { now: clock(1000 + 500) })\n  assert.equal(loaded.has('t'), false)\n  assert.equal(loaded.size(), 0)\n})\n\ntest('loading a missing file gives an empty store', () => {\n  const dir = mkdtempSync(join(tmpdir(), 'kv-hidden-'))\n  const loaded = load(join(dir, 'nothing.json'), { now: clock() })\n  assert.equal(loaded.size(), 0)\n  loaded.set('a', 1)\n  assert.equal(loaded.get('a'), 1)\n})\n\ntest('save replaces the file and leaves no temporary file behind', () => {\n  const dir = mkdtempSync(join(tmpdir(), 'kv-hidden-'))\n  const file = join(dir, 'store.json')\n  writeFileSync(file, 'old content that is not json')\n  const s = createStore({ now: clock() })\n  s.set('a', 1)\n  save(s, file)\n  assert.ok(existsSync(file))\n  assert.deepEqual(readdirSync(dir), ['store.json'])\n  assert.equal(load(file, { now: clock() }).get('a'), 1)\n})\n`,
    },
    solution: {
      'src/kv.js': "/** A key-value store with per-key expiry, judged by an injectable clock. */\nexport function createStore({ now = Date.now } = {}) {\n  const entries = new Map()\n  const live = (key) => {\n    const e = entries.get(key)\n    if (!e) return undefined\n    if (e.expiresAt !== null && now() >= e.expiresAt) {\n      entries.delete(key)\n      return undefined\n    }\n    return e\n  }\n  return {\n    set(key, value, { ttlMs } = {}) {\n      entries.set(key, { value, expiresAt: ttlMs === undefined ? null : now() + ttlMs })\n    },\n    get: (key) => live(key)?.value,\n    has: (key) => live(key) !== undefined,\n    delete: (key) => entries.delete(key),\n    size() {\n      for (const key of [...entries.keys()]) live(key)\n      return entries.size\n    },\n    entries() {\n      return [...entries.keys()].flatMap((key) => (live(key) ? [[key, entries.get(key)]] : []))\n    },\n    restore(key, value, expiresAt) {\n      entries.set(key, { value, expiresAt })\n    },\n  }\n}\n",
      'src/persist.js': "import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'\nimport { createStore } from './kv.js'\n\n/** Writes the live entries as JSON: a temporary file in the same directory, then a rename over the target. */\nexport function save(store, file) {\n  const data = store.entries().map(([key, e]) => ({ key, value: e.value, expiresAt: e.expiresAt }))\n  const temporary = file + '.' + process.pid + '.tmp'\n  writeFileSync(temporary, JSON.stringify(data))\n  renameSync(temporary, file)\n}\n\n/** A store with the saved entries, each keeping its absolute expiry time. */\nexport function load(file, { now = Date.now } = {}) {\n  const store = createStore({ now })\n  if (!existsSync(file)) return store\n  for (const e of JSON.parse(readFileSync(file, 'utf8'))) {\n    if (e.expiresAt === null || now() < e.expiresAt) store.restore(e.key, e.value, e.expiresAt)\n  }\n  return store\n}\n",
    },
  }],
}

// ───────────────────────────── 8. workspace ─────────────────────────────

const ORDER_SCHEMA = `${JSON.stringify({ title: 'Order', type: 'object', required: ['id', 'total'], properties: { id: { type: 'string' }, total: { type: 'number' } } }, null, 2)}\n`
const ORDER_SCHEMA_V2 = `${JSON.stringify({ title: 'Order', type: 'object', required: ['id', 'total'], properties: { id: { type: 'string' }, total: { type: 'number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'EUR' } } }, null, 2)}\n`

const workspace: CampaignTask = {
  key: 'workspace',
  category: 'Workspace / cross-repository task',
  kind: 'workspace',
  mode: 'build',
  budgetMinutes: 75,
  prompt: "Add an optional `currency` to orders across the platform. The order contract (contracts/order.schema.json, owned by the schemas repository) gets a property `currency`: a string of exactly three uppercase letters, not required, default 'EUR'. In the schemas repository, `validateOrder` in src/validate.js accepts an order without a currency and rejects a currency that is not three uppercase letters with the error 'currency: must be three uppercase letters'. In the orders-service repository, the copy of the contract is kept identical to the provider's, and `createOrder` in src/createOrder.js returns the order with its currency, 'EUR' when none was given, and throws an Error with the same message for an invalid one. Existing orders without a currency keep working. Both repositories have tests for the new behaviour.",
  contract: { key: 'order', name: 'Order', path: 'contracts/order.schema.json', copyPath: 'contracts/order.schema.json' },
  repos: [
    {
      name: 'schemas',
      knowledge: [{ title: 'Contract changes are additive', content: 'A consumer may run against an older provider and the reverse. A new property of a contract is optional with a default; a property is never added to `required` in the same release that introduces it.', filePaths: ['contracts/order.schema.json'], source: 'architect' }],
      files: {
        'package.json': pkg('schemas'),
        'README.md': '# Schemas\n\nThe contracts of the platform and their validators. Consumers keep a copy of a contract.\n',
        'contracts/order.schema.json': ORDER_SCHEMA,
        'src/validate.js': "/** Returns the list of problems of an order; an empty list means it is valid. */\nexport function validateOrder(order) {\n  const errors = []\n  if (typeof order.id !== 'string' || order.id === '') errors.push('id: required')\n  if (typeof order.total !== 'number' || Number.isNaN(order.total)) errors.push('total: must be a number')\n  return errors\n}\n",
        'src/validate.test.js': `${HEAD}import { validateOrder } from './validate.js'\n\ntest('a complete order is valid', () => {\n  assert.deepEqual(validateOrder({ id: 'o1', total: 12.5 }), [])\n})\n\ntest('a missing id is reported', () => {\n  assert.deepEqual(validateOrder({ total: 1 }), ['id: required'])\n})\n`,
      },
      hidden: {
        'hidden.test.js': `${HEAD}import { readFileSync } from 'node:fs'\nimport { validateOrder } from './src/validate.js'\n\ntest('the contract has an optional currency with a default', () => {\n  const schema = JSON.parse(readFileSync(new URL('./contracts/order.schema.json', import.meta.url), 'utf8'))\n  assert.equal(schema.properties.currency.type, 'string')\n  assert.equal(schema.properties.currency.default, 'EUR')\n  assert.ok(!schema.required.includes('currency'), 'currency is not required')\n  assert.deepEqual(schema.required.slice().sort(), ['id', 'total'])\n  assert.ok(new RegExp(schema.properties.currency.pattern).test('USD'))\n  assert.ok(!new RegExp(schema.properties.currency.pattern).test('usd'))\n  assert.ok(!new RegExp(schema.properties.currency.pattern).test('EURO'))\n})\n\ntest('the validator accepts an absent or valid currency and rejects others', () => {\n  assert.deepEqual(validateOrder({ id: 'o1', total: 1 }), [])\n  assert.deepEqual(validateOrder({ id: 'o1', total: 1, currency: 'USD' }), [])\n  for (const bad of ['usd', 'EURO', 'E1R', '', 42]) assert.deepEqual(validateOrder({ id: 'o1', total: 1, currency: bad }), ['currency: must be three uppercase letters'], String(bad))\n  assert.deepEqual(validateOrder({ total: 1, currency: 'USD' }), ['id: required'])\n})\n`,
      },
      solution: {
        'contracts/order.schema.json': ORDER_SCHEMA_V2,
        'src/validate.js': "/** Returns the list of problems of an order; an empty list means it is valid. */\nexport function validateOrder(order) {\n  const errors = []\n  if (typeof order.id !== 'string' || order.id === '') errors.push('id: required')\n  if (typeof order.total !== 'number' || Number.isNaN(order.total)) errors.push('total: must be a number')\n  if (order.currency !== undefined && (typeof order.currency !== 'string' || !/^[A-Z]{3}$/.test(order.currency))) errors.push('currency: must be three uppercase letters')\n  return errors\n}\n",
      },
    },
    {
      name: 'orders-service',
      knowledge: [{ title: 'The contract copy is never edited by hand', content: 'contracts/order.schema.json in this repository is a copy of the file the schemas repository owns. It must be byte-identical to the provider at the version the service was built against.', filePaths: ['contracts/order.schema.json'], source: 'user' }],
      files: {
        'package.json': pkg('orders-service'),
        'README.md': '# Orders service\n\nCreates orders. It keeps a copy of the order contract owned by the schemas repository.\n',
        'contracts/order.schema.json': ORDER_SCHEMA,
        'src/createOrder.js': "/** Creates an order from a request. Throws when the request is not a valid order. */\nexport function createOrder(request) {\n  if (typeof request.id !== 'string' || request.id === '') throw new Error('id: required')\n  if (typeof request.total !== 'number' || Number.isNaN(request.total)) throw new Error('total: must be a number')\n  return { id: request.id, total: request.total }\n}\n",
        'src/createOrder.test.js': `${HEAD}import { createOrder } from './createOrder.js'\n\ntest('an order is created from a valid request', () => {\n  assert.equal(createOrder({ id: 'o1', total: 3 }).total, 3)\n})\n\ntest('a request without an id is refused', () => {\n  assert.throws(() => createOrder({ total: 3 }), /id: required/)\n})\n`,
      },
      hidden: {
        'hidden.test.js': `${HEAD}import { readFileSync } from 'node:fs'\nimport { createOrder } from './src/createOrder.js'\n\ntest('the copy of the contract carries the optional currency', () => {\n  const schema = JSON.parse(readFileSync(new URL('./contracts/order.schema.json', import.meta.url), 'utf8'))\n  assert.equal(schema.properties.currency.default, 'EUR')\n  assert.ok(!schema.required.includes('currency'))\n})\n\ntest('an order without a currency gets EUR and existing fields are kept', () => {\n  assert.deepEqual(createOrder({ id: 'o1', total: 3 }), { id: 'o1', total: 3, currency: 'EUR' })\n})\n\ntest('a given currency is kept', () => {\n  assert.deepEqual(createOrder({ id: 'o1', total: 3, currency: 'USD' }), { id: 'o1', total: 3, currency: 'USD' })\n})\n\ntest('an invalid currency is refused with the shared message', () => {\n  for (const bad of ['usd', 'EURO', '', 7]) assert.throws(() => createOrder({ id: 'o1', total: 3, currency: bad }), /currency: must be three uppercase letters/, String(bad))\n})\n\ntest('the earlier refusals still hold', () => {\n  assert.throws(() => createOrder({ total: 3 }), /id: required/)\n  assert.throws(() => createOrder({ id: 'o1', total: 'x' }), /total: must be a number/)\n})\n`,
      },
      solution: {
        'contracts/order.schema.json': ORDER_SCHEMA_V2,
        'src/createOrder.js': "/** Creates an order from a request. Throws when the request is not a valid order. */\nexport function createOrder(request) {\n  if (typeof request.id !== 'string' || request.id === '') throw new Error('id: required')\n  if (typeof request.total !== 'number' || Number.isNaN(request.total)) throw new Error('total: must be a number')\n  const currency = request.currency === undefined ? 'EUR' : request.currency\n  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('currency: must be three uppercase letters')\n  return { id: request.id, total: request.total, currency }\n}\n",
      },
    },
  ],
}

export const CAMPAIGN_TASKS: CampaignTask[] = [localized, crossModule, feature, refactor, architecture, security, program, workspace]
