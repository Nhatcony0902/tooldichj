// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * module-manifest-helpers.cjs
 * Internal helpers for module-manifest-ops.cjs:
 *   - manifest path resolution
 *   - file list flattening
 *   - file deletion with empty-dir pruning
 *   - ZIP extraction
 *   - directory copy
 *   - conflict detection
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Absolute path to .claude/ directory within a project.
 */
function claudeDir(projectRoot) {
  return path.join(projectRoot, '.claude');
}

/**
 * Absolute path to a module's manifest file.
 * Location: .claude/modules/{name}/.t1k-manifest.json
 */
function manifestPath(projectRoot, moduleName) {
  return path.join(claudeDir(projectRoot), 'modules', moduleName, '.t1k-manifest.json');
}

/**
 * Read and parse a manifest. Returns null if missing or unparseable.
 */
function readManifest(projectRoot, moduleName) {
  const p = manifestPath(projectRoot, moduleName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[manifest-ops] warn: could not parse manifest for "${moduleName}": ${e.message}`);
    return null;
  }
}

/**
 * Flatten manifest.files categories into a single array of .claude/-relative paths.
 *
 * Input categories:
 *   skills    — relative to .claude/skills/   → prefixed with "skills/"
 *   agents    — relative to .claude/agents/   → prefixed with "agents/"
 *   fragments — already .claude/-relative (t1k-*.json files)
 *   other     — already .claude/-relative
 *
 * @param {object} manifest
 * @returns {string[]}
 */
function flattenManifestFiles(manifest) {
  const { skills = [], agents = [], fragments = [], other = [] } = manifest.files || {};
  return [
    ...skills.map(f => `skills/${f}`),
    ...agents.map(f => `agents/${f}`),
    ...fragments,
    ...other,
  ];
}

/**
 * Delete a file at .claude/<relPath> and prune any empty parent directories
 * up to (but not including) the .claude/ root.
 *
 * @param {string} claudeDirPath  Absolute .claude/ path.
 * @param {string} relPath        Path relative to .claude/.
 * @returns {boolean}  true if file existed and was deleted.
 */
function deleteFileAndPrune(claudeDirPath, relPath) {
  const abs = path.join(claudeDirPath, relPath);
  if (!fs.existsSync(abs)) return false;
  fs.rmSync(abs, { force: true });

  let parent = path.dirname(abs);
  while (parent !== claudeDirPath && parent.startsWith(claudeDirPath)) {
    try {
      if (fs.readdirSync(parent).length > 0) break;
      fs.rmdirSync(parent);
      parent = path.dirname(parent);
    } catch {
      break;
    }
  }
  return true;
}

/**
 * Extract a ZIP file into targetDir.
 * Cross-platform: uses `unzip` on Linux/macOS, `PowerShell Expand-Archive` on Windows.
 * Creates targetDir if it does not exist.
 *
 * @param {string} zipPath
 * @param {string} targetDir
 */
function extractZip(zipPath, targetDir) {
  if (!fs.existsSync(zipPath)) throw new Error(`ZIP not found: ${zipPath}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const { execFileSync } = require('child_process');
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force`,
    ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  } else {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', targetDir], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
  }
}

/**
 * Recursively copy all contents of srcDir into dstDir (overwrites existing files).
 *
 * @param {string} srcDir
 * @param {string} dstDir
 */
function copyDirContents(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDirContents(src, dst);
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

/**
 * Detect file ownership conflicts between a new module's manifest and all
 * currently installed modules.
 *
 * @param {string}   projectRoot
 * @param {string}   newModuleName   Name of module being installed.
 * @param {object}   newManifest     Manifest from the new module ZIP.
 * @param {Function} listInstalledFn Injected to avoid circular require.
 * @returns {Array<{ file: string, owner: string }>}
 */
function detectConflicts(projectRoot, newModuleName, newManifest, listInstalledFn) {
  const installed = listInstalledFn(projectRoot);
  const newFiles  = new Set(flattenManifestFiles(newManifest));
  const conflicts = [];

  for (const { name: ownerName } of installed) {
    if (ownerName === newModuleName) continue;
    const ownerManifest = readManifest(projectRoot, ownerName);
    if (!ownerManifest) continue;
    for (const f of flattenManifestFiles(ownerManifest)) {
      if (newFiles.has(f)) conflicts.push({ file: f, owner: ownerName });
    }
  }
  return conflicts;
}

module.exports = {
  claudeDir,
  manifestPath,
  readManifest,
  flattenManifestFiles,
  deleteFileAndPrune,
  extractZip,
  copyDirContents,
  detectConflicts,
};
