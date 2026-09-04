import {
  CATEGORY,
  classifyPullRequest,
  evaluatePolicy,
  requiredCheckState,
  resolveOwners
} from './pull-request-policy.mjs';

const COMMENT_MARKER = '<!-- h5p-managed-policy -->';
const DEFAULT_CHECK_NAME = 'H5P policy approval';

/**
 * Reads the policy ownership map from the trusted base ref.
 * @param {Object} github GitHub client supplied by actions/github-script.
 * @param {string} owner Repository owner.
 * @param {string} repo Repository name.
 * @param {string} ref Trusted base branch or commit.
 * @returns {Promise<string>} Decoded CODEOWNERS text, or an empty string when absent.
 */
async function readCodeowners(github, owner, repo, ref) {
  const path = 'CODEOWNERS';

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

function hasRemovedFiles(files) {
  return files.some((file) => String(file.status || '').toLowerCase() === 'removed');
}

/**
 * Returns true if all commits are authored by dependabot[bot] and verified.
 * @param {Array} commits - The list of commits to evaluate.
 * @returns {boolean} - True if all commits are trusted, false otherwise.
 */
function commitsAreTrusted(commits) {
  return commits.length > 0 && commits.every((commit) => {
    const author = commit.author && commit.author.login;
    const verified = commit.commit && commit.commit.verification && commit.commit.verification.verified === true;
    return verified && author === 'dependabot[bot]';
  });
}

/**
 * Returns a map of the latest review states for each user, filtered by the specified head SHA.
 * @param {Array} reviews - The list of reviews to evaluate.
 * @param {string} headSha - The head SHA to filter reviews by.
 * @returns {Map} - A map of user logins to their latest review state.
 */
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

/**
 * Splits a CODEOWNER string into its type and identifier.
 * @param {string} owner - The CODEOWNER string to split.
 * @returns {Object} - An object containing the type and identifier of the owner.
 */
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

/**
 * Resolves the review targets (users and teams) from a list of CODEOWNER strings.
 * @param {Array} owners - The list of CODEOWNER strings to resolve.
 * @param {string} repositoryOwner - The owner of the repository to filter teams by.
 * @returns {Object} - An object containing arrays of user logins and team slugs.
 */
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

/**
 * Checks if there is an applicable owner approval for the given head SHA.
 * @param {Object} github - The GitHub API client.
 * @param {Array} reviews - The list of reviews to evaluate.
 * @param {Array} owners - The list of CODEOWNER strings to check against.
 * @param {string} headSha - The head SHA to filter reviews by.
 * @returns {boolean} - True if there is an applicable owner approval, false otherwise.
 */
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

function policyState(classification, pullNumber, headSha) {
  return JSON.stringify({
    version: 1,
    pullNumber,
    headSha,
    category: classification.category,
    reason: classification.reason
  });
}

function readPolicyState(checkRun, pullNumber, headSha) {
  if (!checkRun?.external_id) {
    return null;
  }

  try {
    const state = JSON.parse(checkRun.external_id);
    if (state.version !== 1 || state.pullNumber !== pullNumber || state.headSha !== headSha) {
      return null;
    }
    return { category: state.category, reason: state.reason };
  }
  catch {
    return null;
  }
}

/**
 * Upserts a policy check run for the given pull request.
 * @param {Object} github - The GitHub API client.
 * @param {Object} location - The location of the pull request (owner, repo, pullNumber, pullUrl, headSha).
 * @param {Array} checkRuns - The list of existing check runs for the pull request.
 * @param {Object} input - The input data for the policy check (name, externalId, conclusion, title, summary).
 * @returns {Promise<number>} - The ID of the upserted check run.
 */
async function upsertPolicyCheck(github, location, checkRuns, input) {
  const existing = latestPolicyCheck(checkRuns, input.name);
  const desiredStatus = input.conclusion === null ? 'in_progress' : 'completed';
  if (
    existing &&
    existing.status === desiredStatus &&
    (input.conclusion === null || existing.conclusion === input.conclusion)
  ) {
    return existing.id;
  }

  const request = {
    owner: location.owner,
    repo: location.repo,
    name: input.name,
    details_url: location.pullUrl,
    external_id: input.externalId,
    output: { title: input.title, summary: input.summary }
  };

  if (input.conclusion === null) {
    request.status = 'in_progress';
    request.started_at = new Date().toISOString();
  }
  else {
    request.status = 'completed';
    request.conclusion = input.conclusion;
    request.completed_at = new Date().toISOString();
  }

  if (existing && existing.status !== 'completed') {
    await github.rest.checks.update({ ...request, check_run_id: existing.id });
    return existing.id;
  }

  const response = await github.rest.checks.create({ ...request, head_sha: location.headSha });
  return response.data.id;
}

/**
 * @param {{decision: string, approvalRequired: boolean}} result
 * @param {{category: string, reason: string}} classification
 * @param {string[]} owners
 * @param {boolean} ownerApproved
 * @param {boolean} removedFiles
 * @returns {{conclusion: 'success'|'failure'|null, title: string, summary: string, message: string}}
 */
function policyFeedback(result, classification, owners, ownerApproved, removedFiles) {
  const ownerSummary = `Resolved maintainer: ${owners.join(', ')}.`;
  const classificationSummary = `${classification.category}: ${classification.reason} ${ownerSummary}`;
  const unresolvedConclusion = result.approvalRequired && !ownerApproved ? null : 'failure';

  if (result.decision === 'wait-for-required-checks') {
    return {
      conclusion: null,
      title: 'Waiting for required checks',
      summary: `${classification.category}: validation has not completed. ${ownerSummary}`,
      message: 'H5P Automation is waiting for all configured validation checks to finish.'
    };
  }

  if (result.decision === 'would-enable-auto-merge') {
    return {
      conclusion: removedFiles ? 'failure' : 'success',
      title: 'Approval policy passed',
      summary: classificationSummary,
      message: 'Pull request is eligible for auto merge if all required validation checks pass.'
    };
  }

  if (result.decision === 'keep-open-after-owner-review' && !removedFiles) {
    return {
      conclusion: ownerApproved ? 'success' : unresolvedConclusion,
      title: 'Approval recorded; manual merge required',
      summary: classificationSummary,
      message: 'Approval recorded. H5P Automation will keep this pull request open for manual merge.'
    };
  }

  if (removedFiles) {
    return {
      conclusion: unresolvedConclusion,
      title: 'File removal requires manual review',
      summary: `This pull request removes one or more files and requires manual review. ${classificationSummary}`,
      message: 'H5P Automation will keep this pull request open because it removes files.'
    };
  }

  const messages = {
    'request-owner-review': `${owners.join(', ')} approval requested.`,
    'keep-open-and-notify-owner': 'H5P Automation will keep this pull request open because a policy condition is not satisfied.',
    'stop-for-changed-head': 'H5P Automation will stop because the pull request changed during policy evaluation.'
  };

  return {
    conclusion: unresolvedConclusion,
    title: 'Manual review required',
    summary: classificationSummary,
    message: messages[result.decision] || 'H5P Automation will keep this pull request open until the policy can be evaluated.'
  };
}

/**
 * Requests missing reviews from the specified owners for the given pull request.
 * @param {Object} github - The GitHub API client.
 * @param {Object} location - The location of the pull request (owner, repo, pullNumber).
 * @param {Object} currentPull - The current pull request data.
 * @param {Array} owners - The list of CODEOWNER strings to request reviews from.
 */
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

/**
 * Enables auto-merge for the given pull request.
 * GraphQL API is used because the REST API does not support enabling auto-merge.
 * 
 * @param {Object} github - The GitHub API client.
 * @param {string} pullRequestId - The ID of the pull request.
 * @param {string} method - The merge method to use (merge, squash, rebase).
 */
async function enableAutoMerge(github, pullRequestId, method) {
  await github.graphql(`
    mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
        pullRequest { id }
      }
    }
  `, { pullRequestId, mergeMethod: mergeMethod(method) });
}

async function eventPullRequest(github, context) {
  if (context.payload.pull_request) {
    return context.payload.pull_request;
  }

  const workflowRun = context.payload.workflow_run;
  if (!workflowRun || workflowRun.event !== 'pull_request') {
    return null;
  }

  if (workflowRun.pull_requests?.length > 0) {
    return workflowRun.pull_requests[0];
  }

  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    ...context.repo,
    commit_sha: workflowRun.head_sha,
    per_page: 100
  });
  return pulls.find((pull) => pull.state === 'open' && pull.head.sha === workflowRun.head_sha) || null;
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

/**
 * Runs the pull request policy enforcement logic.
 * @param {Object} params - The parameters for the run function.
 * @param {Object} params.github - The GitHub API client.
 * @param {Object} params.context - The GitHub Actions context.
 * @param {Object} params.core - The GitHub Actions core module.
 * @param {Object} params.config - The configuration for the policy enforcement.
 * @param {Object} [params.environment=process.env] - The environment variables (default: process.env).
 * @returns {Promise<Object>} - The result of the policy enforcement, including classification, owners, checkState, approvalSatisfied, and decision.
 */
async function run({ github, context, core, config, environment = process.env }) {
  const { owner, repo } = context.repo;
  const triggeredPull = await eventPullRequest(github, context);
  if (!triggeredPull) {
    core.notice('No pull request is associated with this policy event.');
    return { decision: 'stop-without-pull-request' };
  }

  const pullNumber = triggeredPull.number;
  const initialHeadSha = triggeredPull.head.sha;
  const pullResponse = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const baseRef = pullResponse.data.base.ref;
  const [files, commits, reviews, checks, comments, codeowners] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.checks.listForRef, { owner, repo, ref: initialHeadSha, per_page: 100 }),
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pullNumber, per_page: 100 }),
    readCodeowners(github, owner, repo, baseRef)
  ]);

  let currentPull = pullResponse.data;
  if (currentPull.head.sha !== initialHeadSha) {
    core.notice('The pull request head changed during policy evaluation.');
    return { decision: 'stop-for-changed-head' };
  }

  const changedFiles = files.map((file) => file.filename);
  const removedFiles = hasRemovedFiles(files);
  const metadata = dependabotMetadata(environment, config.dependabotMetadataOutcome);
  const trustedCommits = commitsAreTrusted(commits);
  const checkRuns = checks.flatMap((page) => page.check_runs || page);
  const checkName = config.policyCheckName || DEFAULT_CHECK_NAME;
  const savedClassification = context.payload.workflow_run
    ? readPolicyState(latestPolicyCheck(checkRuns, checkName), pullNumber, initialHeadSha)
    : null;
  const classification = savedClassification || classifyPullRequest({
      author: currentPull.user.login,
      changedFiles,
      translationPatterns: config.translationPatterns,
      dependabotMetadata: metadata,
      dependabotCommitsTrusted: trustedCommits
    });
  const owners = resolveOwners(changedFiles, codeowners, config.fallbackOwner);
  const ownerApproved = await hasApplicableOwnerApproval(github, reviews, owners, initialHeadSha);
  const checkState = requiredCheckState(config.requiredChecks, checkRuns);
  const autoMergeCategory = [CATEGORY.DEPENDENCY_PATCH, CATEGORY.TRANSLATION]
    .includes(classification.category);
  const autoMergeAllowed = !removedFiles && autoMergeCategory && (
    currentPull.user.login !== 'dependabot[bot]' ||
    (classification.category === CATEGORY.DEPENDENCY_PATCH && trustedCommits)
  );
  const result = evaluatePolicy({
    category: classification.category,
    autoMergeAllowed,
    checkState,
    ownerApproved,
    mergeable: currentPull.mergeable,
    headSha: currentPull.head.sha,
    evaluatedHeadSha: initialHeadSha
  });
  const feedback = policyFeedback(result, classification, owners, ownerApproved, removedFiles);
  const location = {
    owner,
    repo,
    pullNumber,
    pullUrl: currentPull.html_url,
    headSha: initialHeadSha
  };

  await upsertPolicyCheck(github, location, checkRuns, {
    name: checkName,
    externalId: policyState(classification, pullNumber, initialHeadSha),
    conclusion: feedback.conclusion,
    title: feedback.title,
    summary: feedback.summary
  });

  if (result.approvalRequired && !ownerApproved) {
    await requestMissingReviews(github, location, currentPull, owners);
  }

  const approvalSatisfied = !result.approvalRequired || ownerApproved;
  await upsertManagedComment(
    github,
    location,
    comments,
    managedCommentBody(feedback.message)
  );

  const autoMergeEligible =
    approvalSatisfied &&
    autoMergeAllowed &&
    checkState.passed &&
    currentPull.mergeable !== false;

  if (currentPull.auto_merge && !autoMergeEligible) {
    await disableAutoMerge(github, currentPull.node_id);
  }
  else if (!currentPull.auto_merge && autoMergeEligible) {
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

export {
  COMMENT_MARKER,
  DEFAULT_CHECK_NAME,
  commitsAreTrusted,
  dependabotMetadata,
  enableAutoMerge,
  eventPullRequest,
  hasRemovedFiles,
  hasApplicableOwnerApproval,
  managedCommentBody,
  mergeMethod,
  policyFeedback,
  policyState,
  readPolicyState,
  requestMissingReviews,
  readCodeowners,
  reviewTargets,
  run,
  upsertManagedComment,
  upsertPolicyCheck
};
