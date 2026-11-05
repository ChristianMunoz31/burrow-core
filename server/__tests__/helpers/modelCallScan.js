// Static scan for AI client calls (`.complete(`, `.stream(`, `.chatWithTools(`) used by
// aiBoundary.test.js. It parses the source (comments and strings are never mistaken for code) and
// reports every such call, including bracket access (`ai['complete'](...)`) and optional calls,
// whose first argument is not an object literal with a real `scope` property.
import { parse } from 'acorn';

const MODEL_METHODS = new Set(['complete', 'stream', 'chatWithTools']);

/** The static name of a member access (`a.b`, `a['b']`, `a[`b`]`), else null. */
function memberName(node) {
  if (node.type !== 'MemberExpression') return null;
  const p = node.property;
  if (!node.computed) return p.type === 'Identifier' ? p.name : null;
  if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
  if (p.type === 'TemplateLiteral' && p.expressions.length === 0 && p.quasis.length === 1) return p.quasis[0].value.cooked;
  return null;
}

const keyName = (prop) => {
  if (prop.type !== 'Property') return null;
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
};

const isUndefinedValue = (v) =>
  (v.type === 'Identifier' && v.name === 'undefined') || (v.type === 'UnaryExpression' && v.operator === 'void');

function visit(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) visit(child, fn);
    else if (value && typeof value.type === 'string') visit(value, fn);
  }
}

/**
 * @param {string} source
 * @returns {{ calls: number, problems: string[] }} `problems` names the offending calls.
 */
export function scanModelCalls(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true });
  } catch {
    try {
      ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch (err) {
      return { calls: 0, problems: [`unparseable source: ${err.message}`] };
    }
  }
  let calls = 0;
  const problems = [];
  visit(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const name = memberName(node.callee);
    if (!name || !MODEL_METHODS.has(name)) return;
    calls += 1;
    const at = `.${name}( at offset ${node.start}`;
    const arg = node.arguments[0];
    if (!arg || arg.type !== 'ObjectExpression') {
      problems.push(`${at}: first argument is not an object literal`);
      return;
    }
    const scope = arg.properties.find((p) => keyName(p) === 'scope');
    if (!scope) problems.push(`${at}: no scope property`);
    else if (isUndefinedValue(scope.value)) problems.push(`${at}: scope is undefined`);
  });
  return { calls, problems };
}
