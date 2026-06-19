// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * module-manifest-ops.cjs
 * Consumer-side manifest lifecycle operations for installed modules.
 *
 * Public API:
 *   install(projectRoot, moduleName, zipPath, opts)  — extract ZIP, detect conflicts
 *   update(projectRoot, moduleName, zipPath)         — diff manifests, remove orphans
 *   remove(projectRoot, moduleName)                  — delete all manifest files
 *   listInstalled(projectRoot)                       — read all .t1k-manifest.json files
 *
 * Manifest location per module:
 *   {projectRoot}/.claude/modules/{name}/.t1k-manifest.json
 *
 * File paths inside the manifest are relative to .claude/:
 *   "skills/foo/SKILL.md"  →  .claude/skills/foo/SKILL.md
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  claudeDir,
  readManifest,
  flattenManifestFiles,
  deleteFileAndPrune,
  extractZip,
  copyDirContents,
  detectConflicts,
} = require('./module-manifest-helpers.cjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read the manifest from an extracted ZIP's staging area.
 * Throws if the manifest is missing (malformed ZIP).
 *
 * @param {string} tempDir     Staging directory where ZIP was extracted.
 * @param {string} moduleName
 * @returns {object}
 */
function readManifestFromStaging(tempDir, moduleName) {
  const p = path.join(tempDir, '.claude', 'modules', moduleName, '.t1k-manifest.json');
  if (!fs.existsSync(p)) {
    throw new Error(`ZIP is missing manifest at .claude/modules/${moduleName}/.t1k-manifest.json`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Extract a ZIP to a temp dir under .claude/, call a callback with the temp path,
 * and clean up the temp dir afterward (even on error).
 *
 * @param {string}   cd        Absolute .claude/ path (temp goes here)
 * @param {string}   suffix    Temp dir name suffix
 * @param {string}   zipPath
 * @param {Function} fn        (tempDir: string) => result
 * @returns {*}  Whatever fn returns.
 */
function withExtractedZip(cd, suffix, zipPath, fn) {
  const tempDir = path.join(cd, suffix);
  try {
    extractZip(zipPath, tempDir);
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Install a module from a ZIP file into the project's .claude/ directory.
 * Performs conflict detection against other installed modules.
 * No-op (with warning) if the module is already installed — use update() instead.
 *
 * @param {string}  projectRoot
 * @param {string}  moduleName
 * @param {string}  zipPath       Absolute path to the module ZIP.
 * @param {object}  [opts]
 * @param {boolean} [opts.force]  If true, skip conflict detection.
 * @returns {{ installed: boolean, conflicts: Array<{file:string, owner:string}> }}
 */
function install(projectRoot, moduleName, zipPath, opts = {}) {
  const cd = claudeDir(projectRoot);
  console.log(`[manifest-ops] Installing ${moduleName} from ${path.basename(zipPath)}`);

  if (readManifest(projectRoot, moduleName)) {
    console.warn(`[manifest-ops] "${moduleName}" already installed. Use update() to upgrade.`);
    return { installed: false, conflicts: [] };
  }

  return withExtractedZip(cd, '.t1k-install-tmp', zipPath, tempDir => {
    const newManifest = readManifestFromStaging(tempDir, moduleName);

    if (!opts.force) {
      const conflicts = detectConflicts(projectRoot, moduleName, newManifest, listInstalled);
      if (conflicts.length > 0) {
        console.error(`[manifest-ops] Conflicts for "${moduleName}":`);
        conflicts.forEach(c => console.error(`  ${c.file} — owned by ${c.owner}`));
        return { installed: false, conflicts };
      }
    }

    copyDirContents(path.join(tempDir, '.claude'), cd);
    console.log(`[manifest-ops] Installed ${moduleName}@${newManifest.version} (${flattenManifestFiles(newManifest).length} file(s))`);
    return { installed: true, conflicts: [] };
  });
}

/**
 * Update an installed module to a new version.
 * Reads the old manifest, extracts the new ZIP, deletes orphaned files
 * (present in old manifest but absent in new), then copies new files.
 *
 * Falls back to install() if the module is not currently installed.
 *
 * @param {string} projectRoot
 * @param {string} moduleName
 * @param {string} zipPath      Absolute path to the new-version ZIP.
 * @returns {{ updated: boolean, removed: string[], added: string[] }}
 */
function update(projectRoot, moduleName, zipPath) {
  const cd          = claudeDir(projectRoot);
  const oldManifest = readManifest(projectRoot, moduleName);

  if (!oldManifest) {
    console.warn(`[manifest-ops] "${moduleName}" not installed — falling back to install()`);
    const r = install(projectRoot, moduleName, zipPath);
    return { updated: r.installed, removed: [], added: [] };
  }

  console.log(`[manifest-ops] Updating ${moduleName} from ${oldManifest.version}...`);

  return withExtractedZip(cd, '.t1k-update-tmp', zipPath, tempDir => {
    const newManifest = readManifestFromStaging(tempDir, moduleName);
    const oldFiles    = new Set(flattenManifestFiles(oldManifest));
    const newFiles    = new Set(flattenManifestFiles(newManifest));

    // Delete files present in old but absent in new (orphans)
    const removed = [];
    for (const f of oldFiles) {
      if (!newFiles.has(f) && deleteFileAndPrune(cd, f)) {
        removed.push(f);
        console.log(`  [update] removed orphan: ${f}`);
      }
    }

    copyDirContents(path.join(tempDir, '.claude'), cd);
    const added = [...newFiles].filter(f => !oldFiles.has(f));

    console.log(`[manifest-ops] Updated ${moduleName}: ${oldManifest.version} -> ${newManifest.version} (+${added.length} -${removed.length})`);
    return { updated: true, removed, added };
  });
}

/**
 * Remove an installed module: delete every file listed in its manifest,
 * then remove the manifest directory.
 *
 * @param {string} projectRoot
 * @param {string} moduleName
 * @returns {{ removed: boolean, deletedFiles: string[] }}
 */
function remove(projectRoot, moduleName) {
  const cd       = claudeDir(projectRoot);
  const manifest = readManifest(projectRoot, moduleName);

  if (!manifest) {
    console.warn(`[manifest-ops] "${moduleName}" is not installed (no manifest found)`);
    return { removed: false, deletedFiles: [] };
  }

  const deletedFiles = [];
  for (const relPath of flattenManifestFiles(manifest)) {
    if (deleteFileAndPrune(cd, relPath)) {
      deletedFiles.push(relPath);
    } else {
      console.warn(`  [remove] already gone: ${relPath}`);
    }
  }

  fs.rmSync(path.join(cd, 'modules', moduleName), { recursive: true, force: true });
  console.log(`[manifest-ops] Removed ${moduleName} (${deletedFiles.length} file(s))`);
  return { removed: true, deletedFiles };
}

/**
 * List all installed modules by reading .t1k-manifest.json files under
 * .claude/modules/. Returns an empty array if no modules are installed.
 *
 * @param {string} projectRoot
 * @returns {Array<{ name: string, version: string, kit: string, fileCount: number }>}
 */
function listInstalled(projectRoot) {
  const modulesDir = path.join(claudeDir(projectRoot), 'modules');
  if (!fs.existsSync(modulesDir)) return [];

  return fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const manifest = readManifest(projectRoot, e.name);
      if (!manifest) return null;
      return {
        name:      e.name,
        version:   manifest.version   || 'unknown',
        kit:       manifest.kit       || 'unknown',
        fileCount: flattenManifestFiles(manifest).length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { install, update, remove, listInstalled };
