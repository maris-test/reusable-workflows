'use strict';

const {
  classifyPullRequest,
  evaluatePolicy,
  requiredCheckState,
  resolveOwners
} = require('./pull-request-policy.cjs');

const COMMENT_MARKER = '<!-- h5p-managed-policy -->';
const DEFAULT_CHECK_NAME = 'H5P policy approval';

async function readCodeowners(github, owner, repo, ref) {
  for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    try {
      const response = await github.rest.repos.getContent({ owner, repo, path, ref });
      if (!Array.isArray(response.data) && response.data.content) {
        return Buffer.from(response.data.content, response.data.encoding || 'base64').toString('utf8');
      }
    }
    catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }
  return '';
}

function dependabotMetadata(environment, outcome) {
  if (outcome !== 'success') {
    return { valid: false };
  }
  return {
    valid: true,
    updateType: environment.DEPENDABOT_UPDATE_TYPE,
    previousVersion: environment.DEPENDABOT_PREVIOUS_VERSION,
    newVersion: environment.DEPENDABOT_NEW_VERSION,
    dependencies: String(environment.DEPENDABOT_DEPENDENCIES || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function commitsAreTrusted(commits) {
  return commits.length > 0 && commits.every((commit) => {
    const author = commit.author && commit.author.login;
    const verified = commit.commit && commit.commit.verification && commit.commit.verification.verified === true;
    return verified && author === 'dependabot[bot]';
  });
}

function latestReviewStates(reviews, headSha) {
  const states = new Map();
  for (const review of reviews) {
    const login = review.user && review.user.login;
    if (!login || (review.commit_id && review.commit_id !== headSha)) {
      continue;
    }
    states.set(login, String(review.state || '').toUpperCase());
  }
  return states;
}

function splitOwner(owner) {
  const value = String(owner).replace(/^@/, '');
  const separator = value.indexOf('/');
  if (separator === -1) {
    return { type: 'user', login: value };
  }
  return {
    type: 'team',
    organization: value.slice(0, separator),
    slug: value.slice(separator + 1)
  };
}

function reviewTargets(owners, repositoryOwner) {
  const users = new Set();
  const teams = new Set();
  for (const owner of owners) {
    const target = splitOwner(owner);
    if (target.type === 'user') {
      users.add(target.login);
    }
    else if (target.organization === repositoryOwner) {
      teams.add(target.slug);
    }
  }
  return { users: [...users], teams: [...teams] };
}

async function hasApplicableOwnerApproval(github, reviews, owners, headSha) {
  const approvedUsers = [...latestReviewStates(reviews, headSha).entries()]
    .filter(([, state]) => state === 'APPROVED')
    .map(([login]) => login);

  for (const owner of owners) {
    const target = splitOwner(owner);
    if (target.type === 'user' && approvedUsers.includes(target.login)) {
      return true;
    }
    if (target.type === 'team') {
      for (const login of approvedUsers) {
        try {
          const response = await github.rest.teams.getMembershipForUserInOrg({
            org: target.organization,
            team_slug: target.slug,
            username: login
          });
          if (response.data.state === 'active') {
            return true;
          }
        }
        catch (error) {
          if (error.status !== 404) {
            throw error;
          }
        }
      }
    }
  }
  return false;
}

function managedCommentBody(message) {
  return `${COMMENT_MARKER}
${message}`;
}

async function upsertManagedComment(github, location, comments, body) {
  const existing = comments.find((comment) => String(comment.body || '').includes(COMMENT_MARKER));
  if (existing) {
    if (existing.body !== body) {
      await github.rest.issues.updateComment({
        owner: location.owner,
        repo: location.repo,
        comment_id: existing.id,
        body
      });
    }
    return existing.id;
  }
  const response = await github.rest.issues.createComment({
    owner: location.owner,
    repo: location.repo,
    issue_number: location.pullNumber,
    body
  });
  return response.data.id;
}

function latestPolicyCheck(checkRuns, name) {
  return checkRuns
    .filter((run) => run.name === name)
    .sort((left, right) => new Date(right.started_at || 0) - new Date(left.started_at || 0))[0];
}

async function upsertPolicyCheck(github, location, checkRuns, input) {
  const existing = latestPolicyCheck(checkRuns, input.name);
  const desiredStatus = input.approved ? 'completed' : 'in_progress';
  const desiredConclusion = input.approved ? 'success' : null;
  if (
    existing &&
    existing.status === desiredStatus &&
    (desiredConclusion === null || existing.conclusion === desiredConclusion)
  ) {
    return existing.id;
  }

  const request = {
    owner: location.owner,
    repo: location.repo,
    name: input.name,
    details_url: location.pullUrl,
    external_id: `h5p-policy-pr-${location.pullNumber}`,
    output: { title: input.title, summary: input.summary }
  };
  if (input.approved) {
    request.status = 'completed';
    request.conclusion = 'success';
    request.completed_at = new Date().toISOString();
  }
  else {
    request.status = 'in_progress';
    request.started_at = new Date().toISOString();
  }

  if (existing && existing.status !== 'completed') {
    await github.rest.checks.update({ ...request, check_run_id: existing.id });
    return existing.id;
  }
  const response = await github.rest.checks.create({ ...request, head_sha: location.headSha });
  return response.data.id;
}

async function requestMissingReviews(github, location, currentPull, owners) {
  const targets = reviewTargets(owners, location.owner);
  const currentUsers = new Set((currentPull.requested_reviewers || []).map((user) => user.login));
  const currentTeams = new Set((currentPull.requested_teams || []).map((team) => team.slug));
  const reviewers = targets.users.filter((login) => !currentUsers.has(login));
  const teamReviewers = targets.teams.filter((slug) => !currentTeams.has(slug));
  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return;
  }
  await github.rest.pulls.requestReviewers({
    owner: location.owner,
    repo: location.repo,
    pull_number: location.pullNumber,
    reviewers,
    team_reviewers: teamReviewers
  });
}

function mergeMethod(value) {
  const normalized = String(value || 'merge').toUpperCase();
  if (!['MERGE', 'SQUASH', 'REBASE'].includes(normalized)) {
    throw new Error(`Unsupported merge method: ${value}`);
  }
  return normalized;
}

async function enableAutoMerge(github, pullRequestId, method) {
  await github.graphql(`
    mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
        pullRequest { id }
      }
    }
  `, { pullRequestId, mergeMethod: mergeMethod(method) });
}

async function disableAutoMerge(github, pullRequestId) {
  await github.graphql(`
    mutation DisableAutoMerge($pullRequestId: ID!) {
      disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
        pullRequest { id }
      }
    }
  `, { pullRequestId });
}

async function run({ github, context, core, config, environment = process.env }) {
  const pullNumber = context.payload.pull_request.number;
  const { owner, repo } = context.repo;
  const initialHeadSha = context.payload.pull_request.head.sha;
  const baseRef = context.payload.pull_request.base.ref;
  const [files, commits, reviews, checks, comments, codeowners, pullResponse] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.checks.listForRef, { owner, repo, ref: initialHeadSha, per_page: 100 }),
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pullNumber, per_page: 100 }),
    readCodeowners(github, owner, repo, baseRef),
    github.rest.pulls.get({ owner, repo, pull_number: pullNumber })
  ]);

  const currentPull = pullResponse.data;
  if (currentPull.head.sha !== initialHeadSha) {
    core.notice('The pull request head changed during policy evaluation.');
    return { decision: 'stop-for-changed-head' };
  }

  const changedFiles = files.map((file) => file.filename);
  const metadata = dependabotMetadata(environment, config.dependabotMetadataOutcome);
  const trustedCommits = commitsAreTrusted(commits);
  const classification = classifyPullRequest({
    author: currentPull.user.login,
    changedFiles,
    translationPatterns: config.translationPatterns,
    dependabotMetadata: metadata,
    dependabotCommitsTrusted: trustedCommits
  });
  const owners = resolveOwners(changedFiles, codeowners, config.fallbackOwner);
  const ownerApproved = await hasApplicableOwnerApproval(github, reviews, owners, initialHeadSha);
  const checkRuns = checks.flatMap((page) => page.check_runs || page);
  const checkState = requiredCheckState(config.requiredChecks, checkRuns);
  const autoMergeAllowed = currentPull.user.login !== 'dependabot[bot]' || (metadata.valid && trustedCommits);
  const result = evaluatePolicy({
    category: classification.category,
    autoMergeAllowed,
    checkState,
    ownerApproved,
    mergeable: currentPull.mergeable,
    headSha: currentPull.head.sha,
    evaluatedHeadSha: initialHeadSha
  });
  const approvalSatisfied = !result.approvalRequired || ownerApproved;
  const location = {
    owner,
    repo,
    pullNumber,
    pullUrl: currentPull.html_url,
    headSha: initialHeadSha
  };

  await upsertPolicyCheck(github, location, checkRuns, {
    name: config.policyCheckName || DEFAULT_CHECK_NAME,
    approved: approvalSatisfied,
    title: approvalSatisfied ? 'Approval policy passed' : 'CODEOWNER approval required',
    summary: `${classification.category}: ${classification.reason} Resolved owner: ${owners.join(', ')}.`
  });
  if (result.approvalRequired && !ownerApproved) {
    await requestMissingReviews(github, location, currentPull, owners);
  }

  let message;
  if (!approvalSatisfied) {
    message = `${owners.join(', ')} approval requested.`;
  }
  else if (!autoMergeAllowed) {
    message = `${owners.join(', ')}, automation will keep this pull request open because Dependabot no longer owns every verified commit.`;
  }
  else {
    message = `${owners.join(', ')}, the approval policy passed. Platform auto-merge can wait for the required validation checks.`;
  }
  await upsertManagedComment(github, location, comments, managedCommentBody(message));

  if (currentPull.auto_merge && (!approvalSatisfied || !autoMergeAllowed)) {
    await disableAutoMerge(github, currentPull.node_id);
  }
  else if (!currentPull.auto_merge && approvalSatisfied && autoMergeAllowed) {
    await enableAutoMerge(github, currentPull.node_id, config.mergeMethod);
  }

  await core.summary
    .addHeading('H5P pull request policy enforcement')
    .addTable([
      [{ data: 'Field', header: true }, { data: 'Value', header: true }],
      ['Category', classification.category],
      ['Approval required', String(result.approvalRequired)],
      ['Approval satisfied', String(approvalSatisfied)],
      ['Resolved owners', owners.join(', ')],
      ['Decision', result.decision],
      ['Head SHA', initialHeadSha]
    ])
    .write();
  core.setOutput('category', classification.category);
  core.setOutput('decision', result.decision);
  core.setOutput('owners', JSON.stringify(owners));
  return { classification, owners, checkState, approvalSatisfied, ...result };
}

module.exports = {
  COMMENT_MARKER,
  DEFAULT_CHECK_NAME,
  commitsAreTrusted,
  dependabotMetadata,
  hasApplicableOwnerApproval,
  managedCommentBody,
  mergeMethod,
  requestMissingReviews,
  reviewTargets,
  run,
  upsertManagedComment,
  upsertPolicyCheck
};
