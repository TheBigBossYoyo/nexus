import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  resolveStaticPath,
  readStaticFile,
  isAllowedUpload,
  saveUpload,
  deepMerge,
  loadConfig,
  render,
  verifyToken,
  isAllowedOrigin,
} from '../src/index.js'

const t = (name, fn) => test(name, { timeout: 20000 }, fn)

async function withSandbox(fn) {
  const base = await mkdtemp(path.join(tmpdir(), 'sec-hardening-'))
  try {
    return await fn(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** True when p is root itself or a path below it. */
function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p))
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel))
}

function attempt(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

// ------------------------------------------------------------- static files

const TRAVERSAL_PAYLOADS = [
  '/../secret.txt',
  '/../../secret.txt',
  '..\\secret.txt',
  '/..\\secret.txt',
  '/a/../../secret.txt',
  '/a\\..\\..\\secret.txt',
  '/%2e%2e/secret.txt',
  '/%2E%2E%2Fsecret.txt',
  '/..%2fsecret.txt',
  '/..%5csecret.txt',
  '/%2e%2e%5csecret.txt',
  '/%2e%2e/%2e%2e/secret.txt',
  '/....//secret.txt',
  '/..;/secret.txt',
  '/../public-secret/hidden.txt',
  '/..\\public-secret\\hidden.txt',
  '/%2e%2e%2fpublic-secret%2fhidden.txt',
  '/../public-secret',
  '/%252e%252e/secret.txt',
  '/..%c0%afsecret.txt',
  '/.. /secret.txt',
  '/...\\secret.txt',
  'C:\\Windows\\win.ini',
  'C:/Windows/win.ini',
  '/C:/Windows/win.ini',
  '/C:\\Windows\\win.ini',
  'C:secret.txt',
  '\\\\server\\share\\file.txt',
  '//server/share/file.txt',
  '/\\\\server\\share\\file.txt',
  '/index.html\0.png',
  '/%00',
  '/index.html%00.png',
  '/%E0%A4%A',
  '/%c0%ae%c0%ae/secret.txt',
  '/index.html::$DATA',
  '/index.html:stream',
]

async function buildSite(base) {
  const root = path.join(base, 'public')
  await mkdir(path.join(root, 'assets'), { recursive: true })
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await mkdir(path.join(root, '..hidden'), { recursive: true })
  await mkdir(path.join(base, 'public-secret'), { recursive: true })
  await writeFile(path.join(root, 'index.html'), '<h1>home</h1>')
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1)')
  await writeFile(path.join(root, 'docs', 'a b.txt'), 'spaced')
  await writeFile(path.join(root, '..hidden', 'ok.txt'), 'dotdot-prefix is a legal name')
  await writeFile(path.join(base, 'secret.txt'), 'TOP SECRET')
  await writeFile(path.join(base, 'public-secret', 'hidden.txt'), 'TOP SECRET SIBLING')
  return root
}

t('static: every traversal payload is rejected or stays strictly inside the root', () =>
  withSandbox(async (base) => {
    const root = await buildSite(base)
    for (const payload of TRAVERSAL_PAYLOADS) {
      const r = attempt(() => resolveStaticPath(root, payload))
      if (r.ok) assert.ok(isInside(root, r.value), 'escaped the root: ' + JSON.stringify(payload) + ' -> ' + r.value)
      else assert.ok(r.error instanceof Error, 'must throw an Error for ' + JSON.stringify(payload))
    }
  }))

t('static: the plainly hostile payloads are rejected outright', () =>
  withSandbox(async (base) => {
    const root = await buildSite(base)
    for (const payload of ['/../secret.txt', '..\\secret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/../public-secret/hidden.txt', 'C:\\Windows\\win.ini', '/index.html%00.png']) {
      assert.throws(() => resolveStaticPath(root, payload), Error, JSON.stringify(payload))
    }
  }))

t('static: readStaticFile never discloses files outside the root', () =>
  withSandbox(async (base) => {
    const root = await buildSite(base)
    for (const payload of TRAVERSAL_PAYLOADS) {
      let result
      try {
        result = await readStaticFile(root, payload)
      } catch {
        continue
      }
      const text = result.body.toString()
      assert.ok(!text.includes('TOP SECRET'), 'leaked data for ' + JSON.stringify(payload))
      assert.ok(isInside(root, result.path), 'served a file outside the root for ' + JSON.stringify(payload))
    }
  }))

t('static: legitimate requests keep working', () =>
  withSandbox(async (base) => {
    const root = await buildSite(base)
    assert.equal(path.resolve(resolveStaticPath(root, '/assets/app.js')), path.join(root, 'assets', 'app.js'))
    assert.equal(path.resolve(resolveStaticPath(root, '/assets/app.js?v=2#top')), path.join(root, 'assets', 'app.js'))
    assert.equal(path.resolve(resolveStaticPath(root, '/docs/a%20b.txt')), path.join(root, 'docs', 'a b.txt'))
    assert.equal(path.resolve(resolveStaticPath(root, '/')), path.resolve(root))
    assert.equal(path.resolve(resolveStaticPath(root, '/..hidden/ok.txt')), path.join(root, '..hidden', 'ok.txt'))
    assert.equal(path.resolve(resolveStaticPath(root, '/docs//a%20b.txt')), path.join(root, 'docs', 'a b.txt'))
    const home = await readStaticFile(root, '/')
    assert.equal(home.body.toString(), '<h1>home</h1>')
    assert.equal(home.contentType, 'text/html; charset=utf-8')
    assert.equal((await readStaticFile(root, '/assets/app.js')).body.toString(), 'console.log(1)')
    assert.equal((await readStaticFile(root, '/docs/a%20b.txt')).body.toString(), 'spaced')
    assert.equal((await readStaticFile(root, '/..hidden/ok.txt')).body.toString(), 'dotdot-prefix is a legal name')
    await assert.rejects(readStaticFile(root, '/nope.txt'), { code: 'ENOENT' })
  }))

t('static: a root given with a trailing separator or as a relative path behaves the same', () =>
  withSandbox(async (base) => {
    const root = await buildSite(base)
    const withSep = root + path.sep
    assert.throws(() => resolveStaticPath(withSep, '/../public-secret/hidden.txt'))
    assert.equal(path.resolve(resolveStaticPath(withSep, '/assets/app.js')), path.join(root, 'assets', 'app.js'))
  }))

// ------------------------------------------------------------- uploads

const BAD_TYPES = [
  'run.exe',
  'page.html',
  'logo.svg',
  'photo.png.exe',
  'photo.png.html',
  'photo.pngx',
  'png',
  'archive.txt.sh',
  'photo.png ',
  'photo.png.',
  'photo.png:evil.exe',
  'photo.png\0.exe',
  'photo.pdf\n.exe',
  '',
]

t('uploads: disallowed or disguised types are rejected', () =>
  withSandbox(async (base) => {
    const uploads = path.join(base, 'uploads')
    for (const name of BAD_TYPES) {
      assert.equal(isAllowedUpload(name), false, JSON.stringify(name))
      await assert.rejects(saveUpload(uploads, name, 'x'), Error, JSON.stringify(name))
    }
    const leftovers = await readdir(uploads).catch(() => [])
    assert.deepEqual(leftovers, [])
  }))

const TRAVERSAL_NAMES = [
  '../evil.png',
  '..\\evil.png',
  '../../evil.png',
  '....//evil.png',
  '....\\\\evil.png',
  '..%2fevil.png',
  'sub/../../evil.png',
  'sub\\..\\..\\evil.png',
  '/evil.png',
  '\\evil.png',
  'C:\\evil.png',
  'C:evil.png',
  '\\\\server\\share\\evil.png',
  '../uploads-sibling/evil.png',
  '..\\uploads-sibling\\evil.png',
  'NUL.txt',
  'evil.txt:hidden.exe',
]

t('uploads: hostile names are rejected or confined to the upload directory', () =>
  withSandbox(async (base) => {
    const uploads = path.join(base, 'uploads')
    await mkdir(uploads, { recursive: true })
    await mkdir(path.join(base, 'uploads-sibling'))
    const before = (await readdir(base)).sort()
    for (const name of TRAVERSAL_NAMES) {
      let saved
      try {
        saved = await saveUpload(uploads, name, 'payload')
      } catch (error) {
        assert.ok(error instanceof Error)
        continue
      }
      assert.ok(isInside(uploads, saved.path) && path.resolve(saved.path) !== path.resolve(uploads), 'escaped: ' + JSON.stringify(name) + ' -> ' + saved.path)
      assert.equal(path.dirname(path.resolve(saved.path)), path.resolve(uploads), 'must be stored directly in the upload dir: ' + JSON.stringify(name))
      assert.ok(!/[\\/:]/.test(saved.name), 'returned name must be a bare file name: ' + JSON.stringify(saved.name))
    }
    assert.deepEqual((await readdir(base)).sort(), before, 'nothing may be created beside the upload dir')
    assert.deepEqual(await readdir(path.join(base, 'uploads-sibling')), [])
  }))

t('uploads: ordinary names are accepted and stored unchanged', () =>
  withSandbox(async (base) => {
    const uploads = path.join(base, 'uploads')
    for (const name of ['photo.png', 'PHOTO.JPG', 'Scan 2024 (final).pdf', 'r\u00e9sum\u00e9.txt', 'a.b.c.txt', 'noext-but.gif', 'anim.JPEG']) {
      assert.equal(isAllowedUpload(name), true, name)
      const saved = await saveUpload(uploads, name, Buffer.from('data-' + name))
      assert.equal(saved.name, name)
      assert.equal(path.resolve(saved.path), path.join(path.resolve(uploads), name))
      assert.equal((await readFile(saved.path)).toString(), 'data-' + name)
    }
  }))

// ------------------------------------------------------------- merge / config

function snapshotPrototypes() {
  return {
    object: Object.getOwnPropertyNames(Object.prototype).sort(),
    array: Object.getOwnPropertyNames(Array.prototype).sort(),
    fn: Object.getOwnPropertyNames(Function.prototype).sort(),
  }
}

function cleanPrototypes() {
  for (const key of ['polluted', 'polluted2', 'polluted3', 'isAdmin']) {
    delete Object.prototype[key]
    delete Array.prototype[key]
    delete Function.prototype[key]
  }
}

const POLLUTION_DOCS = [
  '{"__proto__":{"polluted":"yes"}}',
  '{"a":{"__proto__":{"polluted":"yes"}}}',
  '{"a":{"b":{"__proto__":{"polluted":"yes"}}}}',
  '{"constructor":{"prototype":{"polluted2":"yes"}}}',
  '{"a":{"constructor":{"prototype":{"polluted2":"yes"}}}}',
  '{"__proto__":{"isAdmin":true}}',
  '{"prototype":{"polluted3":"yes"}}',
  '{"list":[{"__proto__":{"polluted":"yes"}}]}',
]

t('config: prototype pollution payloads leave Object.prototype and friends untouched', () => {
  const before = snapshotPrototypes()
  try {
    for (const doc of POLLUTION_DOCS) {
      const config = loadConfig(doc, { safe: { value: 1 } })
      assert.equal(({}).polluted, undefined, doc)
      assert.equal(({}).polluted2, undefined, doc)
      assert.equal(({}).polluted3, undefined, doc)
      assert.equal(({}).isAdmin, undefined, doc)
      assert.equal(config.polluted, undefined, doc)
      assert.equal(config.isAdmin, undefined, doc)
      assert.equal(Object.getPrototypeOf(config), Object.prototype, doc)
      assert.equal(Object.hasOwn(config, 'constructor'), false, doc)
      assert.equal(config.safe.value, 1, 'other keys must survive: ' + doc)
      assert.deepEqual(snapshotPrototypes(), before, doc)
    }
    const direct = {}
    deepMerge(direct, JSON.parse('{"__proto__":{"polluted":"yes"},"ok":1}'))
    assert.equal(({}).polluted, undefined)
    assert.equal(direct.polluted, undefined)
    assert.equal(direct.ok, 1)
    const nested = deepMerge({ a: {} }, JSON.parse('{"a":{"__proto__":{"polluted":"yes"},"keep":true}}'))
    assert.equal(({}).polluted, undefined)
    assert.equal(nested.a.polluted, undefined)
    assert.equal(nested.a.keep, true)
  } finally {
    cleanPrototypes()
  }
})

t('config: loadConfig still merges normally and similar looking keys are fine', () => {
  const defaults = { server: { port: 80, tls: { enabled: false } }, list: [1, 2], name: 'x' }
  const config = loadConfig('{"server":{"tls":{"enabled":true},"proto":"h2"},"list":[3],"prototypeId":7,"constructorName":"c","__proto":1}', defaults)
  assert.deepEqual(config.server, { port: 80, tls: { enabled: true }, proto: 'h2' })
  assert.deepEqual(config.list, [3])
  assert.equal(config.prototypeId, 7)
  assert.equal(config.constructorName, 'c')
  assert.equal(config.name, 'x')
  assert.deepEqual(defaults, { server: { port: 80, tls: { enabled: false } }, list: [1, 2], name: 'x' })
})

t('config: merging does not alias the source objects', () => {
  const source = { a: { b: { c: 1 } } }
  const merged = deepMerge({}, source)
  merged.a.b.c = 2
  assert.equal(source.a.b.c, 1)
})

t('config: invalid documents are rejected', () => {
  assert.throws(() => loadConfig('{nope'), SyntaxError)
  for (const doc of ['[]', 'null', '42', '"text"']) assert.throws(() => loadConfig(doc, {}), Error, doc)
})

// ------------------------------------------------------------- templates

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (dec) return String.fromCodePoint(parseInt(dec, 10))
    return named[name.toLowerCase()] ?? m
  })
}

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '" onfocus="alert(1)" autofocus="',
  '<svg/onload=alert(1)>',
  '</textarea><script>steal()</script>',
  '&lt;already&gt; & <b>mixed</b>',
  '<a href="javascript:alert(1)">x</a>',
  "Tom & Jerry's \"show\" > 5 < 6",
]

t('template: values are HTML-escaped in text and attribute positions', () => {
  for (const payload of XSS_PAYLOADS) {
    const html = render('<p title="{{ v }}" data-x=\'{{ v }}\'>{{ v }}</p>', { v: payload })
    const inner = html.slice('<p title="'.length)
    // Template-owned markup only: every character that could open a tag or close an attribute must be gone from the value.
    const stripped = html.replace('<p title="', '').replace('" data-x=\'', '').replace('\'>', '').replace(/<\/p>$/, '')
    assert.ok(!/[<>"']/.test(stripped), 'unescaped markup character leaked for ' + JSON.stringify(payload) + ': ' + html)
    assert.ok(inner.length > 0)
    assert.equal(decodeEntities(stripped), payload + payload + payload, 'value must round-trip through entity decoding')
  }
})

t('template: numbers, empty values and replacement-pattern characters', () => {
  assert.equal(render('{{ a }}|{{ b }}|{{ c }}|{{ d }}', { a: 0, b: 12.5, c: '', d: null }), '0|12.5||')
  assert.equal(decodeEntities(render('{{ v }}', { v: '$& $1 $$ $` $\'' })), '$& $1 $$ $` $\'')
  assert.equal(render('{{ user.name }} / {{user.address.city}}', { user: { name: 'Ada', address: { city: 'London' } } }), 'Ada / London')
  assert.equal(render('no placeholders <b>ok</b>', {}), 'no placeholders <b>ok</b>')
})

t('template: placeholders cannot reach inherited or built-in members', () => {
  const polluted = () => ({}).polluted
  assert.equal(polluted(), undefined)
  const probes = ['constructor', 'constructor.name', 'constructor.constructor', '__proto__', '__proto__.polluted', 'toString', 'hasOwnProperty', 'user.constructor', 'user.__proto__', 'user.toString', 'list.map', 'list.constructor.name']
  const data = { user: { name: 'Ada' }, list: [1, 2] }
  for (const probe of probes) {
    assert.equal(render('[{{ ' + probe + ' }}]', data), '[]', probe)
  }
  assert.equal(render('[{{ user }}]', data), '[]', 'objects are not stringified')
  assert.equal(render('[{{ user.name }}][{{ list.0 }}]', data), '[Ada][1]')
})

// ------------------------------------------------------------- auth

t('auth: verifyToken is correct and never throws on odd inputs', () => {
  const secret = 'sk_live_9f8e7d6c5b4a'
  assert.equal(verifyToken(secret, secret), true)
  assert.equal(verifyToken('sk_live_9f8e7d6c5b4b', secret), false)
  assert.equal(verifyToken('sk_live_9f8e7d6c5b4', secret), false)
  assert.equal(verifyToken(secret + 'x', secret), false)
  assert.equal(verifyToken('', secret), false)
  // same string length, different UTF-8 byte length: a naive timingSafeEqual(Buffer, Buffer) throws here
  assert.equal(verifyToken('\u00e9', 'a'), false)
  assert.equal(verifyToken('a', '\u00e9'), false)
  assert.equal(verifyToken('\u00e9\u00e9', 'abcd'), false)
  assert.equal(verifyToken('\u00e9\u00e9', '\u00e9\u00e9'), true)
  // an unset or empty secret must never authenticate anyone
  assert.equal(verifyToken('', ''), false)
  assert.equal(verifyToken(undefined, undefined), false)
  assert.equal(verifyToken(null, null), false)
  assert.equal(verifyToken(undefined, secret), false)
  assert.equal(verifyToken(secret, undefined), false)
  assert.equal(verifyToken(123456, 123456), false)
  assert.equal(verifyToken([secret], secret), false)
  assert.equal(verifyToken({ toString: () => secret }, secret), false)
})

const ALLOWED = ['https://app.example.com', 'http://localhost:3000']

t('auth: look-alike origins are rejected', () => {
  for (const origin of [
    'https://app.example.com.evil.com',
    'https://app.example.com.evil.com:443',
    'https://app.example.com@evil.com',
    'https://evil.com/https://app.example.com',
    'https://evilapp.example.com',
    'https://xapp.example.com',
    'https://app.example.com:8443',
    'http://app.example.com',
    'https://app.example.org',
    'http://localhost:30001',
    'http://localhost:3000.evil.com',
    'http://localhost:3000@evil.com',
    'http://localhost',
    'null',
    '',
    'app.example.com',
    '*',
  ]) {
    assert.equal(isAllowedOrigin(origin, ALLOWED), false, JSON.stringify(origin))
  }
  for (const bad of [undefined, null, 42, {}, []]) assert.equal(isAllowedOrigin(bad, ALLOWED), false)
  assert.equal(isAllowedOrigin('https://app.example.com', []), false)
})

t('auth: configured origins are accepted', () => {
  assert.equal(isAllowedOrigin('https://app.example.com', ALLOWED), true)
  assert.equal(isAllowedOrigin('http://localhost:3000', ALLOWED), true)
  assert.equal(isAllowedOrigin('https://app.example.com', ['https://other.example.org', 'https://app.example.com']), true)
})
