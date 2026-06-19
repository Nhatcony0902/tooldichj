#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * mcp-applies.cjs — the `appliesWhen` evaluator for check-mcp-health.cjs.
 *
 * Decides whether a single MCP entry should be reminded in the current session
 * context. OR semantics across the present keys; an absent/empty `appliesWhen`
 * ⇒ applies (the tier=optional cooldown bounds any nag). Pure + side-effect-free
 * so it unit-tests in isolation against synthetic ctx objects.
 *
 * Grammar (registry-schema.md → t1k-config / mcp):
 *   always: true                 ⇒ every session
 *   projectType: "<t>" | ["…"]   ⇒ ctx.projectType is (one of) these
 *   owningKit: "<kit>"           ⇒ ctx.framework === kit
 *   moduleInstalled: "<m>"|["…"] ⇒ membership in ctx.installedModules
 *
 * In global-only mode (ctx.isGlobalOnly), projectType/owningKit are FALSE
 * (there is no project context); always/moduleInstalled still evaluate.
 *
 * Fail-open: a malformed entry returns false here (the hook skips it with a
 * one-line stderr note) — never throws, never crashes the SessionStart chain.
 */
'use strict';

function _members(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/**
 * @param {object} entry  one mcp.{required,recommended,optional}[] entry
 * @param {{ projectType?: string, framework?: string, isGlobalOnly?: boolean, installedModules?: string[] }} ctx
 * @returns {boolean} true ⇒ entry applies in this context
 */
function mcpApplies(entry, ctx) {
  if (!entry || typeof entry !== 'object') return false;
  const aw = entry.appliesWhen;

  // No appliesWhen (or not an object) ⇒ applies; cooldown bounds the nag.
  if (aw == null) return true;
  if (typeof aw !== 'object' || Array.isArray(aw)) return false; // malformed ⇒ skip

  const keys = Object.keys(aw);
  if (keys.length === 0) return true; // empty object ⇒ applies

  // Fail-OPEN on an all-unrecognized predicate (e.g. a typo'd `projetType`):
  // apply rather than silently suppress forever. A shown reminder is itself the
  // visible signal to the kit author; the tier=optional cooldown bounds the nag.
  // (A recognized-but-unmatched key — moduleInstalled for an uninstalled module —
  // still falls through to the correct `return false` below; that is gating, not a typo.)
  const KNOWN = ['always', 'projectType', 'owningKit', 'moduleInstalled'];
  if (!keys.some(k => KNOWN.includes(k))) return true;

  const c = ctx || {};
  const installed = Array.isArray(c.installedModules) ? c.installedModules.map(String) : [];

  // OR across present keys.
  if (aw.always === true) return true;

  // projectType / owningKit are FALSE in global-only mode (no project context).
  if ('projectType' in aw && !c.isGlobalOnly) {
    if (c.projectType != null && _members(aw.projectType).includes(String(c.projectType))) return true;
  }
  if ('owningKit' in aw && !c.isGlobalOnly) {
    if (c.framework != null && String(aw.owningKit) === String(c.framework)) return true;
  }
  if ('moduleInstalled' in aw) {
    if (_members(aw.moduleInstalled).some(m => installed.includes(m))) return true;
  }

  return false;
}

module.exports = { mcpApplies };
