// KB dark CSS gate: scripts/gate-kb-css.mjs turns the original (features/kb-dark/source/dark.original.css) into
// features/kb-dark/dark.css. Every theme selector gets the zero-specificity gate :where(:root:not([data-milo-kb-off]))
// — conjoined with a root compound (html / :root), otherwise prepended as an ancestor — and nothing else changes:
// same rules, same declarations, same order, same per-selector specificity (computed here independently).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GATE, OFF_ATTRIBUTE, HEADER, gateCss, renderOutput, renderSheet, gateSelector, parseRules, ORIGINAL, OUTPUT, SHEETS, headerFor} from '../scripts/gate-kb-css.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8');

// ---- independent specificity calculator (Selectors Level 4) — shares no code with the transformer ----
/** Own top-level comma splitter (strings, escapes, (), []), deliberately not the transformer's splitTopLevel. */
function splitList(list) {
  const parts = [];
  let depth = 0, q = null, cur = '';
  for (let k = 0; k < list.length; k++) {
    const ch = list[k];
    if (ch === '\\') { cur += ch + (list[k + 1] ?? ''); k++; continue; }
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}
function specificity(selector) {
  let a = 0, b = 0, c = 0;
  const s = selector.trim();
  let i = 0;
  const add = ([x, y, z]) => { a += x; b += y; c += z; };
  const max = list => splitList(list).map(specificity).reduce((m, v) => (cmp(v, m) > 0 ? v : m), [0, 0, 0]);
  const readParen = () => { // s[i] === '('
    let depth = 0, j = i, q = null;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    const inner = s.slice(i + 1, j);
    i = j + 1;
    return inner;
  };
  const ident = () => { const m = /^-?(?:[_a-zA-Z0-9-]|\\.)+/.exec(s.slice(i)); i += m ? m[0].length : 0; return m ? m[0] : ''; };
  while (i < s.length) {
    const ch = s[i];
    if (' >+~\n\t'.includes(ch)) { i++; continue; }
    if (ch === '#') { i++; ident(); a++; continue; }
    if (ch === '.') { i++; ident(); b++; continue; }
    if (ch === '[') { let q = null; for (; i < s.length; i++) { const d = s[i]; if (q) { if (d === q) q = null; continue; } if (d === '"' || d === "'") q = d; else if (d === ']') break; } i++; b++; continue; }
    if (ch === '*') { i++; continue; }
    if (s.startsWith('::', i)) { i += 2; ident(); if (s[i] === '(') readParen(); c++; continue; }
    if (ch === ':') {
      i++;
      const name = ident().toLowerCase();
      if (['before', 'after', 'first-line', 'first-letter'].includes(name)) { c++; continue; }
      if (s[i] === '(') {
        const inner = readParen();
        if (name === 'where') continue;
        if (['is', 'not', 'has', 'matches'].includes(name)) { add(max(inner)); continue; }
        if (/^nth-(last-)?child$/.test(name)) { b++; const m = /\sof\s(.+)$/s.exec(inner); if (m) add(max(m[1])); continue; }
        b++; continue; // other functional pseudo-classes (nth-of-type, lang, dir, ...)
      }
      b++; continue;
    }
    if (/[a-zA-Z_-]/.test(ch)) { ident(); c++; continue; }
    throw new Error(`specificity: unexpected ${JSON.stringify(ch)} in ${selector}`);
  }
  return [a, b, c];
}
const cmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

test('specificity calculator sanity (spec examples)', () => {
  assert.deepEqual(specificity('html body :where(.a, #b)'), [0, 0, 2]);
  assert.deepEqual(specificity(':root'), [0, 1, 0]);
  assert.deepEqual(specificity('a:not(.btn):hover'), [0, 2, 1]);
  assert.deepEqual(specificity(':is(#x, .y) li::placeholder'), [1, 0, 2]);
  assert.deepEqual(specificity('li:nth-of-type(odd) > td'), [0, 1, 2]);
  assert.deepEqual(specificity(`:where(${GATE.slice(7, -1)}) p`), [0, 0, 1]);
  assert.deepEqual(specificity('div[style*="a, b"]'), [0, 1, 1]);
  assert.deepEqual(splitList('a, b:is(c, d), [x="e,f"], g\\,h'), ['a', ' b:is(c, d)', ' [x="e,f"]', ' g\\,h']);
});

test('committed features/kb-dark/dark.css equals the transformer output of the original stylesheet (deterministic)', () => {
  assert.equal(ORIGINAL, 'features/kb-dark/source/dark.original.css');
  assert.equal(OUTPUT, 'features/kb-dark/dark.css');
  const out = renderOutput(read(ORIGINAL));
  assert.equal(read(OUTPUT), out, 'run `node scripts/gate-kb-css.mjs` to regenerate');
  assert.equal(renderOutput(read(ORIGINAL)), out, 'deterministic');
  assert.equal(out, HEADER + gateCss(read(ORIGINAL)));
  // byte-for-byte: removing every gate from the output (minus the header) gives back the original exactly
  const esc = GATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ungated = out.slice(HEADER.length).replace(new RegExp(`(^|[\\s,}])${esc} `, 'g'), '$1').split(GATE).join('');
  assert.equal(ungated, read(ORIGINAL));
});

test('every original rule is gated: same rules, declarations, order; specificity unchanged per selector', () => {
  const orig = parseRules(read(ORIGINAL));
  const gated = parseRules(read(OUTPUT));
  assert.equal(orig.length, 31, 'the actual dark.css has 31 style rules');
  assert.equal(gated.length, orig.length);
  let selectors = 0, conjoined = 0, prefixed = 0;
  orig.forEach((r, k) => {
    const g = gated[k];
    assert.equal(g.body, r.body, `rule ${k}: declarations unchanged`);
    assert.deepEqual(g.atRules, r.atRules, `rule ${k}: same @media/@supports context`);
    const os = splitList(r.selector);
    const gs = splitList(g.selector);
    assert.equal(gs.length, os.length, `rule ${k}: one gated branch per selector-list branch`);
    os.forEach((sel, n) => {
      selectors++;
      const out = gs[n];
      assert.deepEqual(specificity(out), specificity(sel), `specificity of ${sel}`);
      assert.equal(out.split(GATE).length - 1, 1, `exactly one gate in ${out}`);
      assert.equal(out.replace(GATE, '').replace(/\s+/g, ' ').trim(), sel.replace(/\s+/g, ' ').trim(), `only the gate was added to ${sel}`);
      if (/^(html|:root)\b/i.test(sel.trim())) {
        conjoined++;
        assert.ok(!out.startsWith(`${GATE} `), `root compound conjoined, no impossible root ancestor: ${out}`);
      } else {
        prefixed++;
        assert.ok(out.startsWith(`${GATE} `), `descendant selector gets the ancestor gate: ${out}`);
      }
    });
  });
  // the actual file: every top-level selector starts with html or :root ⇒ all conjoined
  assert.deepEqual({selectors, conjoined, prefixed}, {selectors: 31, conjoined: 31, prefixed: 0});
  const css = read(OUTPUT);
  for (const sel of [':root:where(:root:not([data-milo-kb-off]))', 'html:where(:root:not([data-milo-kb-off])) body ::selection',
    'html:where(:root:not([data-milo-kb-off])) body :where(input, textarea)::placeholder', 'html:where(:root:not([data-milo-kb-off])) {']) {
    assert.ok(css.includes(sel), sel);
  }
  assert.equal(OFF_ATTRIBUTE, 'data-milo-kb-off');
  assert.equal(GATE, ':where(:root:not([data-milo-kb-off]))');
});

test('every sheet in SHEETS is committed fresh and fully gated (the /tcp additions too)', () => {
  assert.deepEqual(SHEETS.map(s => [s.source, s.output]), [
    ['features/kb-dark/source/dark.original.css', 'features/kb-dark/dark.css'],
    ['features/kb-dark/source/tcp.extra.css', 'features/kb-dark/dark-tcp.css']
  ]);
  for (const sheet of SHEETS) {
    const out = renderSheet(sheet);
    assert.equal(read(sheet.output), out, `${sheet.output}: run \`node scripts/gate-kb-css.mjs\` to regenerate`);
    assert.ok(out.startsWith(headerFor(sheet)), `${sheet.output}: header names its own source`);
    const rules = parseRules(out);
    assert.ok(rules.length > 0, `${sheet.output}: has rules`);
    for (const r of rules) {
      for (const branch of splitList(r.selector)) {
        assert.equal(branch.split(GATE).length - 1, 1, `${sheet.output}: exactly one gate in ${branch}`);
        assert.ok(!/^\s*$/.test(branch.replace(GATE, '')), `${sheet.output}: gated selector is not empty`);
      }
    }
  }
  // the tcp sheet only touches /tcp-specific classes: every branch is rooted at html body
  for (const r of parseRules(read('features/kb-dark/dark-tcp.css'))) {
    for (const branch of splitList(r.selector)) assert.match(branch.trim(), /^html:where\(:root:not\(\[data-milo-kb-off\]\)\) body /, branch);
  }
  assert.equal(parseRules(read('features/kb-dark/dark-tcp.css')).length, 14, 'the tcp sheet has 14 style rules');
});

test('gateSelector: lists, pseudo-elements, root compounds, descendants, strings/escapes', () => {
  const G = GATE;
  assert.equal(gateSelector(':root'), `:root${G}`);
  assert.equal(gateSelector('html'), `html${G}`);
  assert.equal(gateSelector('HTML.x body'), `HTML.x${G} body`);
  assert.equal(gateSelector('html::selection'), `html${G}::selection`, 'gate goes before a pseudo-element');
  assert.equal(gateSelector(':root:hover > body'), `:root:hover${G} > body`);
  assert.equal(gateSelector('html body a:not(.btn):hover'), `html${G} body a:not(.btn):hover`);
  assert.equal(gateSelector('div.a, html p, :root'), `${G} div.a, html${G} p, :root${G}`);
  assert.equal(gateSelector('p::placeholder'), `${G} p::placeholder`);
  assert.equal(gateSelector('div[title="html, :root"] > p'), `${G} div[title="html, :root"] > p`, 'commas/keywords inside strings');
  assert.equal(gateSelector('span:is(.a, .b)'), `${G} span:is(.a, .b)`);
  assert.equal(gateSelector('html>body'), `html${G}>body`);
  assert.equal(gateSelector('htmlx p'), `${G} htmlx p`, '"htmlx" is not html');
  // cannot decide whether the first compound may match the root element: refuse instead of guessing
  for (const bad of ['.x', '*', '[data-x] p', '::selection', ':not(p) a', '#id .x', ':host']) assert.throws(() => gateSelector(bad), /root/, bad);
  assert.throws(() => gateSelector(`${G} p`), /already gated/);
});

test('gateCss: @media/@supports recurse; @keyframes/@font-face untouched; comments kept; nesting refused', () => {
  const src = `/* a { b } */\n@media (min-width: 1px) {\n  html body p { color: red; }\n  @supports (display: grid) { html .g { display: grid } }\n}\n@keyframes k { from { opacity: 0 } to { opacity: 1 } }\n@font-face { font-family: x; src: local(x); }\nhtml td::after { content: "} {"; }\n`;
  const out = gateCss(src);
  assert.ok(out.startsWith('/* a { b } */'));
  assert.ok(out.includes(`@media (min-width: 1px) {\n  html${GATE} body p { color: red; }`));
  assert.ok(out.includes(`@supports (display: grid) { html${GATE} .g { display: grid } }`));
  assert.ok(out.includes('@keyframes k { from { opacity: 0 } to { opacity: 1 } }'));
  assert.ok(out.includes('@font-face { font-family: x; src: local(x); }'));
  assert.ok(out.includes(`html${GATE} td::after { content: "} {"; }`));
  assert.throws(() => gateCss('html p { color: red; & span { color: blue } }'), /nested/);
  assert.throws(() => gateCss('@scope (.a) { p { color: red } }'), /@scope/);
  assert.throws(() => gateCss('html p { color: red'), /unterminated|unbalanced/);
});

test('gateCss refuses @import (the imported sheet would be ungated), quoted or not, with media', () => {
  for (const src of ['@import url("x.css");\nhtml p { a: b }', '@import url(x.css) screen;\nhtml p{a:b}', "@IMPORT 'x.css';"]) {
    assert.throws(() => gateCss(src), /@import/, src);
  }
  assert.equal(gateCss('@charset "utf-8";\nhtml p{a:b}'), `@charset "utf-8";\nhtml${GATE} p{a:b}`, 'other statement at-rules still copied');
});

test('gateSelector refuses namespace (|) and escapes (\\) in the first compound; later compounds are fine', () => {
  for (const bad of ['ns|html p', '*|html p', '|html p', 'svg|svg', 'html\\:x p', '.a\\:root p', ':ro\\6f t p', 'html[lang|=en] p']) {
    assert.throws(() => gateSelector(bad), /namespace|escape/, bad);
  }
  assert.equal(gateSelector('html p.a\\:b'), `html${GATE} p.a\\:b`);
  assert.equal(gateSelector('html [lang|=en]'), `html${GATE} [lang|=en]`);
});

test('gateCss: unquoted url(...) containing braces/semicolons is a value, not nesting', () => {
  assert.equal(gateCss('html p { b: url(data:x;{) }'), `html${GATE} p { b: url(data:x;{) }`);
  assert.equal(gateCss('html p { b: URL(a}b); c: d }\nhtml q{e:f}'), `html${GATE} p { b: URL(a}b); c: d }\nhtml${GATE} q{e:f}`);
  assert.equal(gateCss('html p { b: url( "a{" ) }'), `html${GATE} p { b: url( "a{" ) }`, 'quoted url still a string');
  assert.throws(() => gateCss('html p { b: myurl(x) { } }'), /nested/, 'only a real url( token is skipped');
});
