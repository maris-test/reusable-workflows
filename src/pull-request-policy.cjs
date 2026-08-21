'use strict';

const CATEGORY = Object.freeze({
  DEPENDENCY_PATCH: 'dependency-patch',
  DEPENDENCY_REVIEW: 'dependency-review',
  TRANSLATION: 'translation',
  MANUAL: 'manual'
});

function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globToRegex(pattern, options = {}) {
  let source = normalizePath(pattern);
  const directoryPattern = source.endsWith('/');
  const anchored = source.startsWith('/');
  source = source.replace(/^\//, '').replace(/\/$/, '');

  let expression = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '*') {
      if (source[index + 1] === '*') {
        expression += '.*';
        index += 1;
      }
      else {
        expression += '[^/]*';
      }
    }
    else if (character === '?') {
      expression += '[^/]';
    }
    else {
      expression += escapeRegex(character);
    }
  }

  if (directoryPattern) {
    expression += '(?:/.*)?';
  }

  const basenamePattern = !source.includes('/');
  const prefix = options.codeowners && basenamePattern && !anchored ? '(?:^|.*/)' : '^';
  return new RegExp(`${prefix}${expression}$`);
}

function matchesAnyPattern(path, patterns) {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => globToRegex(pattern).test(normalized));
}

function parseStableVersion(version) {
  const match = String(version || '').trim().match(/^[v=]?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isAtLeastOne(version) {
  const parsed = parseStableVersion(version);
  return parsed !== null && parsed.major >= 1;
}

function validDependabotMetadata(metadata) {
  return Boolean(
    metadata &&
    metadata.valid === true &&
    typeof metadata.updateType === 'string' &&
    typeof metadata.previousVersion === 'string' &&
    typeof metadata.newVersion === 'string' &&
    Array.isArray(metadata.dependencies) &&
    metadata.dependencies.length > 0
  );
}

function classifyPullRequest(input) {
  const changedFiles = input.changedFiles || [];
  const translationPatterns = input.translationPatterns || [];
  const isDependabot = input.author === 'dependabot[bot]';

  if (isDependabot) {
    if (!validDependabotMetadata(input.dependabotMetadata)) {
      return { category: CATEGORY.MANUAL, reason: 'Dependabot metadata is invalid or incomplete.' };
    }
    if (!input.dependabotCommitsTrusted) {
      return { category: CATEGORY.MANUAL, reason: 'A commit is unverified or does not belong to Dependabot.' };
    }

    const metadata = input.dependabotMetadata;
    const stablePatch =
      metadata.updateType === 'version-update:semver-patch' &&
      isAtLeastOne(metadata.previousVersion) &&
      isAtLeastOne(metadata.newVersion);
    if (stablePatch) {
      return { category: CATEGORY.DEPENDENCY_PATCH, reason: 'Dependabot supplied a verified stable patch at or above 1.0.0.' };
    }
    return { category: CATEGORY.DEPENDENCY_REVIEW, reason: 'The dependency update is not an eligible stable patch.' };
  }

  if (
    changedFiles.length > 0 &&
    translationPatterns.length > 0 &&
    changedFiles.every((path) => matchesAnyPattern(path, translationPatterns))
  ) {
    return { category: CATEGORY.TRANSLATION, reason: 'Only configured translation files changed.' };
  }
  return { category: CATEGORY.MANUAL, reason: 'The change is mixed or does not match a managed category.' };
}

function stripCodeownersComment(line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '#' && (index === 0 || line[index - 1] !== '\\')) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseCodeowners(content) {
  const rules = [];
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const fields = stripCodeownersComment(rawLine).trim().split(/\s+/).filter(Boolean);
    const owners = fields.slice(1).filter((owner) => owner.startsWith('@'));
    if (fields.length >= 2 && owners.length > 0) {
      rules.push({ pattern: fields[0].replace(/\\#/g, '#'), owners });
    }
  }
  return rules;
}

function resolveOwners(changedFiles, codeownersContent, fallbackOwner) {
  const fallback = String(fallbackOwner).startsWith('@') ? String(fallbackOwner) : `@${fallbackOwner}`;
  const rules = parseCodeowners(codeownersContent);
  const owners = new Set();
  for (const path of changedFiles.length > 0 ? changedFiles : ['']) {
    let pathOwners = [];
    for (const rule of rules) {
      if (globToRegex(rule.pattern, { codeowners: true }).test(normalizePath(path))) {
        pathOwners = rule.owners;
      }
    }
    for (const owner of pathOwners.length > 0 ? pathOwners : [fallback]) {
      owners.add(owner);
    }
  }
  return [...owners];
}

function requiredCheckState(requiredChecks, checkRuns) {
  const latestByName = new Map();
  for (const run of checkRuns) {
    const current = latestByName.get(run.name);
    if (!current || new Date(run.started_at || 0) >= new Date(current.started_at || 0)) {
      latestByName.set(run.name, run);
    }
  }

  const failed = [];
  const pending = [];
  for (const name of requiredChecks) {
    const run = latestByName.get(name);
    if (!run || run.status !== 'completed') {
      pending.push(name);
    }
    else if (!['success', 'neutral', 'skipped'].includes(run.conclusion)) {
      failed.push(name);
    }
  }
  return { failed, pending, passed: failed.length === 0 && pending.length === 0 };
}

function evaluatePolicy(input) {
  const approvalRequired = ![
    CATEGORY.DEPENDENCY_PATCH,
    CATEGORY.TRANSLATION
  ].includes(input.category);
  if (input.headSha !== input.evaluatedHeadSha) {
    return { approvalRequired, decision: 'stop-for-changed-head' };
  }
  if (input.checkState.failed.length > 0 || input.mergeable === false) {
    return { approvalRequired, decision: 'keep-open-and-notify-owner' };
  }
  if (approvalRequired && !input.ownerApproved) {
    return { approvalRequired, decision: 'request-owner-review' };
  }
  if (input.autoMergeAllowed === false) {
    return { approvalRequired, decision: 'keep-open-after-owner-review' };
  }
  return { approvalRequired, decision: 'would-enable-auto-merge' };
}

module.exports = {
  CATEGORY,
  classifyPullRequest,
  evaluatePolicy,
  globToRegex,
  matchesAnyPattern,
  parseCodeowners,
  parseStableVersion,
  requiredCheckState,
  resolveOwners
};
