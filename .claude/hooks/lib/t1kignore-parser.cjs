#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// t1kignore-parser.cjs — Parse .t1kignore file and return glob patterns
// Used by scout-block.cjs to load per-project custom block patterns.
// Format: one glob pattern per line, # for comments, blank lines ignored.
'use strict';

const fs = require('fs');
const path = require('path');

// Cache parsed patterns for the session lifetime (keyed by file mtime)
let _cache = null;
let _cacheMtime = null;

/**
 * Parse .t1kignore from projectRoot. Returns array of regex patterns.
 * Missing file → returns []. Never throws.
 * @param {string} projectRoot — absolute path to project root
 * @returns {RegExp[]}
 */
function parseT1kIgnore(projectRoot) {
  try {
    const ignoreFile = path.join(projectRoot, '.t1kignore');

    // Check file exists
    let stat;
    try {
      stat = fs.statSync(ignoreFile);
    } catch {
      return []; // no .t1kignore — normal case
    }

    // Return cached result if file unchanged
    if (_cache !== null && _cacheMtime === stat.mtimeMs) {
      return _cache;
    }

    const lines = fs.readFileSync(ignoreFile, 'utf8').split('\n');
    const patterns = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue; // skip blank lines and comments

      // Convert glob pattern to regex (basic conversion for common cases)
      const regex = globToRegex(line);
      if (regex) patterns.push(regex);
    }

    // Cache result
    _cache = patterns;
    _cacheMtime = stat.mtimeMs;
    return patterns;
  } catch {
    return []; // fail-open — never block on parse errors
  }
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: * (any chars except /), ** (any chars including /), ? (single char), trailing /
 * @param {string} glob
 * @returns {RegExp|null}
 */
function globToRegex(glob) {
  try {
    // Normalize: trailing slash means directory match
    const isDir = glob.endsWith('/');
    let g = isDir ? glob.slice(0, -1) : glob;

    // Escape regex special chars except * and ?
    let regexStr = g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters
      .replace(/\*\*/g, '\x00GLOBSTAR\x00')   // placeholder for **
      .replace(/\*/g, '[^/]*')                // * → match non-slash chars
      .replace(/\?/g, '[^/]')                 // ? → single non-slash char
      .replace(/\x00GLOBSTAR\x00/g, '.*');    // ** → match anything including /

    // Match at path boundary (directory prefix or full match)
    if (isDir) {
      regexStr = `(^|/)${regexStr}(/|$)`;
    } else {
      regexStr = `(^|/)${regexStr}($|/)`;
    }

    return new RegExp(regexStr);
  } catch {
    return null; // invalid pattern — skip silently
  }
}

module.exports = { parseT1kIgnore, globToRegex };
