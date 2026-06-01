/* CI guard: cross-file top-level identifier collisions.

   The browser loads js/*.js as classic <script> tags that SHARE ONE global
   scope. Two files declaring the same top-level `const`/`let`/`function`/`class`
   throws "Identifier 'X' has already been declared" and aborts the *entire*
   second file — which repeatedly shipped a dead game to production this project.

   `node --check` validates each file in isolation and is blind to this. This
   script parses each script with the real JS engine (vm + a SourceTextModule-free
   approach using Function length tricks is unreliable), so instead we use a light
   but correct tokenizer: strip comments and strings, then walk brace depth and
   collect declarations made at depth 0. Any name declared at top level in two
   files is reported as a collision. Exit 1 on any finding.

   Run: node tools/check-collisions.js
*/
const fs = require('fs');
const path = require('path');

// Files are loaded in this order by index.html and share global scope.
const FILES = ['js/config.js', 'js/cloud.js', 'js/levels.js', 'js/puzzle.js', 'js/effects.js', 'js/app.js'];

// Remove // and /* */ comments and the CONTENTS of string/template/regex
// literals, so braces/keywords inside them never affect parsing. We keep the
// delimiters so positions stay sane. This is a pragmatic scanner, not a full
// parser, but it correctly handles the constructs this codebase uses.
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = '';   // last significant char, to disambiguate regex vs divide
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += q; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          // template expression: copy through with brace matching (may contain code)
          out += '${'; i += 2; let d = 1;
          while (i < n && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; if (d > 0) out += src[i]; i++; }
          out += '}'; continue;
        }
        if (src[i] === q) break;
        i++;
      }
      out += q; i++; prev = q; continue;
    }
    // regex literal: a "/" that starts a value position (after these tokens)
    if (c === '/' && /[=(,:;[{!&|?+\-*%^~<>]|^$/.test(prev || '')) {
      out += '/'; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') { while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
        if (src[i] === '/') break;
        i++;
      }
      out += '/'; i++; prev = '/'; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// Collect names declared at brace-depth 0 (also depth 0 of parens, to avoid
// picking up function params / destructuring inside calls).
function topLevelDecls(src) {
  const s = strip(src);
  const names = new Set();
  let depth = 0, paren = 0, bracket = 0;
  // tokenize into words + punctuation positions
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    if (depth !== 0 || paren !== 0 || bracket !== 0) continue;
    // match a declaration keyword at a word boundary
    const m = /^(?:const|let|var|function\*?|async\s+function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(s.slice(i));
    if (m && (i === 0 || /[^\w$]/.test(s[i - 1]))) {
      names.add(m[1]);
    }
  }
  return names;
}

const seen = new Map();   // name -> file that first declared it
const collisions = [];
const root = path.join(__dirname, '..');
for (const f of FILES) {
  const full = path.join(root, f);
  if (!fs.existsSync(full)) continue;
  const decls = topLevelDecls(fs.readFileSync(full, 'utf8'));
  for (const name of decls) {
    if (seen.has(name)) collisions.push(`${name}  (${seen.get(name)} & ${f})`);
    else seen.set(name, f);
  }
}

if (collisions.length) {
  console.error('COLLISION: top-level identifier declared in multiple files (will crash in the browser):');
  for (const c of collisions) console.error('  - ' + c);
  console.error('\nFix: declare the name in ONE file and read it elsewhere via the namespace\n' +
                '(e.g. const localAlias = window.SHIKAKU_PUZZLE.theName).');
  process.exit(1);
}
console.log('OK: no cross-file top-level identifier collisions (' + seen.size + ' names across ' + FILES.length + ' files)');
