#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// descriptive-name.cjs — PreToolUse hook on Write: blocks if new files don't follow naming conventions
// Exit 2 = block (requires user approval to proceed). Fail-open on errors.
'use strict';
try {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { parseHookStdin, findProjectRoot, resolveClaudeDir, T1K } = require('./telemetry-utils.cjs');

  const input = parseHookStdin();
  if (!input) process.exit(0);

  const filePath = (input.tool_input || {}).file_path || '';
  if (!filePath) process.exit(0);

  // Scoping rule (issue #400): repo naming hygiene applies ONLY to files inside
  // the project. Ephemeral / out-of-repo Writes — scratch scripts under the OS
  // temp dir (os.tmpdir(), cross-platform) or any path outside the resolved
  // project root — are exempt; they never get committed and must not be blocked.
  // Also honor T1K_DESCRIPTIVE_NAME=0 as a global opt-out. This runs BEFORE any
  // naming check. Fail-open: if the project root cannot be determined the path
  // falls through to the existing behavior (never blocks extra). The outer
  // try/catch keeps any unexpected throw fail-open too.
  {
    if (process.env.T1K_DESCRIPTIVE_NAME === '0') process.exit(0);

    const absPath = path.resolve(filePath);
    // OS temp dir — covers platform-correct locations on Linux/macOS/Windows
    // (e.g. macOS resolves os.tmpdir() under /var/folders/...). No hardcoded
    // platform path literals (cross-platform gate forbids them).
    const tmpDir = path.resolve(os.tmpdir());
    if (absPath === tmpDir || absPath.startsWith(tmpDir + path.sep)) process.exit(0);
    try {
      const projectRoot = findProjectRoot();
      if (projectRoot) {
        const rel = path.relative(projectRoot, absPath);
        if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) process.exit(0);
      }
    } catch { /* fail-open: undeterminable root → fall through to naming check */ }
  }

  const basename = path.basename(filePath);
  const ext = path.extname(basename).toLowerCase();
  // Strip compound extensions: foo.test.cjs → foo, foo.handler.ts → foo.
  // Dotted-role filenames (NestJS / Angular) stack multiple role segments —
  // e.g. `feature.service.spec.ts` or `app.smoke.spec.ts` carry two recognized
  // suffixes. Stripping only the trailing one (issue #454) left `feature.service`
  // / `app.smoke` behind, which is neither kebab nor Pascal → false-positive
  // block. Fix: keep the allowlist data-driven AND strip *every* trailing
  // recognized suffix in a loop until none remains.
  const COMPOUND_SUFFIXES = [
    '.test', '.spec', '.stories', '.story', '.config', '.d',
    // Common architectural / framework suffixes
    '.handler', '.controller', '.service', '.repository', '.middleware',
    '.guard', '.interceptor', '.pipe', '.decorator', '.module',
    '.routes', '.route', '.client', '.server',
    '.dto', '.entity', '.model', '.schema', '.types', '.type',
    '.helper', '.helpers', '.utils', '.util', '.constants', '.constant',
    '.factory', '.adapter', '.provider', '.context', '.hook', '.hooks',
    '.store', '.mapper', '.reducer', '.action', '.selector',
    // NestJS / Angular dotted role suffixes (issue #454): `<kebab>.<role>.<ext>`
    '.resolver', '.directive', '.component', '.gateway', '.strategy',
    '.filter', '.page', '.po',
  ];
  let name = basename.slice(0, -ext.length);
  // Strip every trailing recognized suffix, not just the first match, so that
  // stacked dotted roles (`foo.service.spec`, `app.smoke.spec`) reduce to their
  // bare base name before the case check.
  let strippedAny = true;
  while (strippedAny) {
    strippedAny = false;
    const lower = name.toLowerCase();
    for (const suffix of COMPOUND_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        name = name.slice(0, -suffix.length);
        strippedAny = true;
        break;
      }
    }
  }

  // Extensions to skip (no convention enforced)
  const SKIP_EXTS = new Set(['.md', '.json', '.yml', '.yaml', '.txt', '.env',
    '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc',
    '.babelrc', '.nvmrc', '', '.lock', '.log', '.xml', '.csv', '.toml']);
  if (SKIP_EXTS.has(ext)) process.exit(0);

  // Extensions that require kebab-case
  const KEBAB_EXTS = new Set(['.js', '.ts', '.cjs', '.mjs',
    '.sh', '.bash', '.zsh']);

  // Extensions that require PascalCase
  // .php placed here per modern PSR-1/4 (filename matches class name).
  // Procedural PHP (kebab/snake) will trip — accept that tradeoff for now.
  const PASCAL_EXTS = new Set(['.cs', '.java', '.kt', '.swift', '.fs', '.vb', '.php']);

  // Extensions that require snake_case
  // Python (PEP 8), Ruby (Rails/RSpec) join Go and Rust here.
  const SNAKE_EXTS = new Set(['.go', '.rs', '.py', '.rb']);

  // Extensions accepting EITHER kebab-case (utility) OR PascalCase (component).
  // React/JSX components are PascalCase by convention; utility/page files are
  // typically kebab-case. Both are common in the same project.
  const KEBAB_OR_PASCAL_EXTS = new Set(['.jsx', '.tsx']);

  // .ts routing — PascalCase .ts is legitimate across the ecosystem: React
  // components, type modules (Types.ts), and Cocos Creator components/services
  // (ColorService.ts, TimerComponent.ts per rules/code-conventions-cocos.md).
  // Blocking PascalCase .ts by default is a false positive (issue #393):
  // monorepo Cocos layouts where the Cocos root is a subdirectory never trip
  // auto-detect from the git/CWD root, so they fell through to the kebab-only
  // default and got blocked.
  // Routing is resolved in this order (first match wins):
  //   1. Explicit config: hooks.descriptiveName.tsConvention
  //      values: 'kebab' | 'pascal' | 'pascal-or-kebab' | 'either'
  //      (in any .claude/t1k-config-*.json fragment) — opt into strict
  //      kebab-only or strict pascal-only when a project wants it.
  //   2. Auto-detect Cocos project: presence of project.json AND
  //      settings/v2/packages/ walking up from the file's directory, CWD,
  //      and the T1K-resolved project root (sets 'either', a no-op now that
  //      'either' is the default, but kept for clarity/strict-config overrides).
  //   3. Default: 'either' — accept kebab-case (utility) OR PascalCase
  //      (component/class). This is the #393 fix. Names matching neither
  //      (snake_case, spaces, etc.) are still rejected.
  // See issues #329, #393.
  function readTsConvention(claudeDir) {
    if (!claudeDir) return null;
    try {
      const files = fs.readdirSync(claudeDir)
        .filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'));
      for (const cf of files) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(claudeDir, cf), 'utf8'));
          const v = c.hooks && c.hooks.descriptiveName && c.hooks.descriptiveName.tsConvention;
          if (typeof v === 'string' && v.length > 0) return v.toLowerCase();
        } catch { /* skip unreadable fragment */ }
      }
    } catch { /* no claudeDir or unreadable */ }
    return null;
  }

  function isCocosProjectAt(dir) {
    if (!dir) return false;
    try {
      const hasProjectJson = fs.existsSync(path.join(dir, 'project.json'));
      const hasPackagesDir = fs.existsSync(path.join(dir, 'settings', 'v2', 'packages'));
      return hasProjectJson && hasPackagesDir;
    } catch {
      return false;
    }
  }

  // Walk up from `start` looking for Cocos markers; bounded depth.
  function detectCocosProject(start) {
    let cur = start;
    for (let i = 0; i < 8 && cur && cur !== path.dirname(cur); i++) {
      if (isCocosProjectAt(cur)) return true;
      cur = path.dirname(cur);
    }
    return false;
  }

  // Resolve effective routing for .ts files.
  // Default 'either' (kebab-case utility OR PascalCase component/class) so
  // legitimate PascalCase .ts (React/types/Cocos) is never a false positive
  // (issue #393). Explicit config can still force strict 'kebab' or 'pascal'.
  let tsRouting = 'either';
  if (ext === '.ts') {
    let claudeDir = null;
    try { claudeDir = resolveClaudeDir(); } catch { /* ok */ }
    const configured = readTsConvention(claudeDir);
    if (configured === 'pascal') {
      tsRouting = 'pascal';
    } else if (configured === 'kebab') {
      tsRouting = 'kebab';
    } else if (configured === 'pascal-or-kebab' || configured === 'either') {
      tsRouting = 'either';
    } else {
      const fileDir = path.dirname(filePath) || process.cwd();
      let projectRoot = null;
      try { projectRoot = findProjectRoot(); } catch { /* ok */ }
      if (
        detectCocosProject(fileDir) ||
        detectCocosProject(process.cwd()) ||
        (projectRoot && isCocosProjectAt(projectRoot))
      ) {
        tsRouting = 'either';
      }
    }
  }

  function isKebabCase(s) {
    // Accept dotted kebab segments (issue #454): after recognized role/test
    // suffixes are stripped, NestJS/Angular files can retain a descriptive
    // middle segment — e.g. `app.smoke.spec.ts` reduces to `app.smoke`, and
    // `user.e2e.spec.ts` to `user.e2e`. Each dot-separated segment must itself
    // be kebab-case. Mirrors isPascalCase, which already allows dotted segments.
    return s.split('.').every(seg => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg));
  }

  function isPascalCase(s) {
    // Allow C# partial-class convention: ClassName.PartName(.PartName)*
    // (e.g. BackpackCrawlerSceneSetup.MetaUI.cs). Each segment must be PascalCase.
    return /^[A-Z][a-zA-Z0-9]*(\.[A-Z][a-zA-Z0-9]*)*$/.test(s);
  }

  // Allow leading/trailing underscores so dunder names like `__init__` and
  // private helpers like `_internal_state` pass — both are PEP 8-legitimate.
  function isSnakeCase(s) {
    return /^_*[a-z0-9]+(_[a-z0-9]+)*_*$/.test(s);
  }

  function toKebab(s) {
    return s
      .replace(/([A-Z])/g, '-$1')
      .replace(/_/g, '-')
      .replace(/--+/g, '-')
      .toLowerCase()
      .replace(/^-/, '');
  }

  let violated = false;
  let message = '';

  if (ext === '.ts') {
    if (tsRouting === 'pascal') {
      if (!isPascalCase(name)) {
        violated = true;
        message = `naming: '${basename}' should use PascalCase (e.g., 'MyClass${ext}')`;
      }
    } else if (tsRouting === 'either') {
      if (!isKebabCase(name) && !isPascalCase(name)) {
        violated = true;
        message = `naming: '${basename}' should use kebab-case (utility) or PascalCase (component/class)`;
      }
    } else {
      if (!isKebabCase(name)) {
        violated = true;
        const suggestion = toKebab(name);
        message = `naming: '${basename}' should use kebab-case. Suggested: '${suggestion}${ext}'`;
      }
    }
  } else if (KEBAB_EXTS.has(ext)) {
    if (!isKebabCase(name)) {
      violated = true;
      const suggestion = toKebab(name);
      message = `naming: '${basename}' should use kebab-case. Suggested: '${suggestion}${ext}'`;
    }
  } else if (PASCAL_EXTS.has(ext)) {
    if (!isPascalCase(name)) {
      violated = true;
      message = `naming: '${basename}' should use PascalCase (e.g., 'MyClass${ext}')`;
    }
  } else if (SNAKE_EXTS.has(ext)) {
    if (!isSnakeCase(name)) {
      violated = true;
      message = `naming: '${basename}' should use snake_case (e.g., 'my_module${ext}')`;
    }
  } else if (KEBAB_OR_PASCAL_EXTS.has(ext)) {
    if (!isKebabCase(name) && !isPascalCase(name)) {
      violated = true;
      message = `naming: '${basename}' should use kebab-case (utility/page) or PascalCase (component)`;
    }
  }

  if (violated) {
    // Exit 2 = warn, not block (Claude Code treats exit 2 as advisory)
    console.log(JSON.stringify({
      decision: 'block',
      reason: `descriptive-name: ${message}`,
    }));
    process.exit(2);
  }

  process.exit(0);
} catch (e) {
  process.exit(0); // fail-open
}
