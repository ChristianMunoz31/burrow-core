// Shared by the static boundary tests (proToolsBoundary, eraseBoundary): finds import( and require( calls
// whose argument is not a plain string literal, which could load a module past a static import graph.

/**
 * Every import( and require( call whose argument is not a plain string literal (a variable, a
 * concatenation or a template with ${}).
 * @param {string} file path used in the report
 * @param {string} source file text
 * @returns {string[]} "file: snippet" entries
 */
export function dynamicLoads(file, source) {
  const out = [];
  for (const m of source.matchAll(/\b(?:import|require)\s*\(/g)) {
    const after = source.slice(m.index + m[0].length);
    const plain = /^\s*(?:'[^'\n$]*'|"[^"\n$]*"|`[^`\n$]*`)\s*[,)]/.test(after);
    if (!plain) out.push(`${file}: ${source.slice(m.index, m.index + 60).split('\n')[0]}`);
  }
  return out;
}

/**
 * Explicit allowlist: matches the detector flags that are prose inside string literals, not calls.
 * file -> [snippet start, reason].
 */
export const NOT_A_CALL = Object.freeze({
  'server/config.js': ['require(', 'shell hint text inside a string literal'],
  'server.js': ['import (5 MB limit)', 'user-facing error text inside a string literal'],
});

/**
 * Computed loads in `files`, minus the explicit NOT_A_CALL allowlist.
 * @param {string[]} files repo-relative paths
 * @param {(relPath: string) => string} read
 * @returns {string[]}
 */
export function unexpectedDynamicLoads(files, read) {
  return files
    .flatMap((f) => dynamicLoads(f, read(f)))
    .filter((entry) => {
      const file = entry.slice(0, entry.indexOf(': '));
      const allowed = NOT_A_CALL[file];
      return !(allowed && entry.includes(allowed[0]));
    });
}
