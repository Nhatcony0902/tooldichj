// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
const fs = require('fs');
const path = require('path');
const {
  REQUIRED_FILES,
  validateContext,
  validateRiskGate,
  validateVerification,
  validateReviewDecision,
  validateAdversarial
} = require('./artifact-schema.cjs');
const { isHardStage } = require('./stage-detector.cjs');

const VALIDATORS = {
  'context-snippets.json': validateContext,
  'risk-gate.json': validateRiskGate,
  'verification.json': validateVerification,
  'review-decision.json': validateReviewDecision,
  'adversarial-validation.json': validateAdversarial
};

const SECRET_PATTERNS = [
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bCookie\s*:\s*[^;\n]{12,}/i,
  /\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[^\s"']{8,}/i,
  // GitHub tokens — `gha_` (GitHub Actions) added vs CK upstream.
  /\b(?:ghp|gho|ghu|ghs|gha|github_pat)_[A-Za-z0-9_]{20,}/,
  // OpenAI/Anthropic — allow optional sub-prefix segment (sk-proj-, sk-ant-, etc.)
  // vs CK upstream which only matched bare `sk-{alnum}`.
  // Known low-probability false positive (#324 item 8): the `(?:[a-z]+-)?` group
  // also lets `risk-` qualify, so a benign token like `risk-assessment-<20+ chars>`
  // can match. Acceptable for a defence-in-depth secret scanner — the cost of a
  // rare false-positive (redact-or-confirm prompt) is far below the cost of a
  // leaked `sk-proj-…` key slipping the artifact-gate.
  /\bsk-(?:[a-z]+-)?[A-Za-z0-9_-]{20,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Azure storage connection strings + account keys.
  /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/i,
  /\bDefaultEndpointsProtocol=https;[^"\n]{40,}/i
];

function isRedacted(value) {
  return /\b(?:redacted|masked)\b|\*\*\*/i.test(value);
}

function add(list, type, message, file = null, field = null) {
  list.push({ type, message, file, field });
}

function scanSecrets(value, basePath = '') {
  const hits = [];
  if (typeof value === 'string') {
    if (!isRedacted(value) && SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      hits.push(basePath || '<root>');
    }
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...scanSecrets(item, `${basePath}[${index}]`)));
    return hits;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const next = basePath ? `${basePath}.${key}` : key;
      hits.push(...scanSecrets(item, next));
    }
  }
  return hits;
}

function readArtifacts(artifactDir) {
  const artifacts = {};
  const errors = [];
  const resolvedDir = artifactDir ? path.resolve(artifactDir) : null;
  if (!resolvedDir || !fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    add(errors, 'missing-dir', 'artifact directory is missing');
    return { artifacts, errors };
  }
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(resolvedDir, file);
    if (!filePath.startsWith(resolvedDir + path.sep)) {
      add(errors, 'path-traversal', 'artifact path escaped directory', file);
      continue;
    }
    if (!fs.existsSync(filePath)) {
      add(errors, 'missing-artifact', 'required artifact is missing', file);
      continue;
    }
    try {
      artifacts[file] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      add(errors, 'malformed-json', 'artifact is not valid JSON', file);
    }
  }
  return { artifacts, errors };
}

function validateShapes(artifacts) {
  const errors = [];
  for (const [file, value] of Object.entries(artifacts)) {
    const validator = VALIDATORS[file];
    if (!validator) continue;
    for (const issue of validator(value)) {
      // Type stays the coarse `'schema'` (#324 item 7): the specific violation kind
      // (missing-field / wrong-type / wrong-enum) is carried in `issue.message`, and
      // the precise location in `issue.path`. We keep the coarse type rather than
      // emitting compound `'schema:missing-field'` types because the gate's output
      // consumers match on `type === 'schema'`; the message+path already give the
      // forensic detail. Revisit if a consumer needs to branch on violation kind.
      add(errors, 'schema', issue.message, file, issue.path);
    }
    for (const field of scanSecrets(value)) {
      add(errors, 'secret-like-content', 'secret-like content detected', file, field);
    }
  }
  return errors;
}

function validatePolicy(artifacts, stage, config = {}) {
  const errors = [];
  const warnings = [];
  const hard = isHardStage(stage, config);
  const context = artifacts['context-snippets.json'];
  const risk = artifacts['risk-gate.json'];
  const review = artifacts['review-decision.json'];
  const adversarial = artifacts['adversarial-validation.json'];
  const verification = artifacts['verification.json'];
  const autoMode = context?.mode === 'auto';

  if (autoMode && !risk) add(errors, 'missing-risk-gate-auto', 'auto mode requires risk-gate.json', 'risk-gate.json');
  if (
    autoMode &&
    risk &&
    config.highRiskAutoStop !== false &&
    (risk.highRisk === true || risk.autoStopRequired === true) &&
    risk.humanApproved !== true
  ) {
    add(errors, 'high-risk-auto-stop', 'high-risk auto mode requires human approval', 'risk-gate.json', 'humanApproved');
  }

  if (review) {
    if (review.decision === 'BLOCKED') add(errors, 'blocked-review', 'review decision is BLOCKED', 'review-decision.json');
    if (review.criticalCount > 0) add(errors, 'critical-review', 'review contains critical issues', 'review-decision.json', 'criticalCount');
    if (review.blockingReasons?.length) add(errors, 'blocking-reasons', 'review contains blocking reasons', 'review-decision.json', 'blockingReasons');
    if (review.contractStatus === 'BROKEN') add(errors, 'broken-contract-status', 'review contract status is BROKEN', 'review-decision.json', 'contractStatus');
    if (hard && review.decision !== 'PASS') add(errors, 'hard-stage-needs-pass', 'hard stage requires PASS review', 'review-decision.json', 'decision');
    if (hard && review.contractStatus === 'UNKNOWN') add(errors, 'hard-stage-known-contract', 'hard stage requires known contract status', 'review-decision.json', 'contractStatus');
    if (!hard && review.decision === 'PASS_WITH_RISK') add(warnings, 'pass-with-risk', 'review passed with risk', 'review-decision.json');
  }

  if (adversarial) {
    if (adversarial.decision === 'BLOCKED') add(errors, 'blocked-adversarial', 'adversarial validation is BLOCKED', 'adversarial-validation.json');
    if (adversarial.disprovenClaims?.length) add(errors, 'disproven-claims', 'adversarial review disproved claims', 'adversarial-validation.json', 'disprovenClaims');
    if (adversarial.reachableRegressions?.length) add(errors, 'reachable-regressions', 'reachable regressions found', 'adversarial-validation.json', 'reachableRegressions');
    if (hard && adversarial.decision !== 'PASS') add(errors, 'hard-stage-needs-adversarial-pass', 'hard stage requires PASS adversarial validation', 'adversarial-validation.json', 'decision');
    if (hard && adversarial.unverifiedClaims?.length) add(errors, 'hard-stage-unverified-claims', 'hard stage requires all adversarial claims verified', 'adversarial-validation.json', 'unverifiedClaims');
    if (hard && adversarial.missingProof?.length) add(errors, 'hard-stage-missing-proof', 'hard stage requires proof for adversarial validation', 'adversarial-validation.json', 'missingProof');
    if (!hard && (adversarial.unverifiedClaims?.length || adversarial.missingProof?.length)) {
      add(warnings, 'adversarial-unverified', 'adversarial validation has unverified proof', 'adversarial-validation.json');
    }
  }

  const failedCommands = verification?.commands?.filter((command) => command.status === 'fail') || [];
  if (failedCommands.length) add(errors, 'failed-verification', 'verification contains failed commands', 'verification.json', 'commands');
  const passedCommands = verification?.commands?.filter((command) => command.status === 'pass') || [];
  if (hard && verification && passedCommands.length === 0) {
    add(errors, 'hard-stage-needs-passing-verification', 'hard stage requires at least one passing verification command', 'verification.json', 'commands');
  }

  return { errors, warnings };
}

function validateArtifacts({ artifactDir, stage = 'finalize', config = {} }) {
  const { artifacts, errors: readErrors } = readArtifacts(artifactDir);
  const hard = isHardStage(stage, config);
  const shapeErrors = validateShapes(artifacts);
  const { errors: policyErrors, warnings } = validatePolicy(artifacts, stage, config);
  const missing = readErrors.filter((issue) => issue.type === 'missing-artifact' || issue.type === 'missing-dir');
  const malformed = readErrors.filter((issue) => !missing.includes(issue));
  if (!hard) {
    for (const issue of missing) warnings.push(issue);
  }
  const errors = [
    ...(hard ? readErrors : malformed),
    ...shapeErrors,
    ...policyErrors
  ];
  const status = errors.length ? 'block' : warnings.length ? 'warn' : 'pass';
  return { status, stage, artifactDir, errors, warnings };
}

module.exports = { validateArtifacts, readArtifacts, scanSecrets, validatePolicy };
