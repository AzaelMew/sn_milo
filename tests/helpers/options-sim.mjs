// Execute the real options page with a minimal DOM and deferred worker responses.
import fs from 'node:fs';
import vm from 'node:vm';
import * as view from '../../shared/options-view.mjs';
import * as rules from '../../shared/rules.mjs';
import * as lists from '../../shared/user-lists.mjs';

export function optionsPage() {
  class Element {
    constructor(tag) { this.tagName = tag; this.dataset = {}; this.children = []; this.listeners = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll() { return this.children.flatMap(n => [n, ...n.querySelectorAll()]).filter(n => ['input', 'textarea', 'button'].includes(n.tagName)); }
  }
  const nodes = Object.fromEntries(['features', 'error', 'warnings', 'notice', 'rule-list', 'rules-error', 'rules-state', 'rule-add', 'rules-save', 'forget-seen', ...['ix-accounts', 'inf-recipients'].flatMap(p => [`${p}-text`, `${p}-error`, `${p}-state`, `${p}-save`])].map(id => [id, new Element('div')]));
  const document = {getElementById: id => nodes[id], createElement: tag => new Element(tag), documentElement: new Element('html')};
  const requests = [], focus = [], changes = [];
  const chrome = {runtime: {sendMessage(message) { return new Promise(resolve => requests.push({message, resolve})); }}, storage: {local: {async get() { return {}; }, async set() {}}, onChanged: {addListener(fn) { changes.push(fn); }}}};
  const source = fs.readFileSync(new URL('../../options.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  vm.runInNewContext(source, {...view, ...rules, ...lists, document, chrome, window: {addEventListener(type, fn) { if (type === 'focus') focus.push(fn); }}});
  return {requests, focus, changes, nodes, boxes: () => nodes.features.querySelectorAll().filter(n => n.type === 'checkbox')};
}
export const settleOptions = () => new Promise(resolve => setImmediate(resolve));
