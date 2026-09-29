import { exec, ExecError } from './git';
import { CheckSummary, GhData, PrInfo, PrState, ReviewSummary } from './model';

const OPEN_FIELDS =
  'number,title,url,isDraft,state,headRefName,baseRefName,author,reviewDecision,reviews,reviewRequests,statusCheckRollup,mergeStateStatus,isCrossRepository';
// The recent-history call is only used to badge branches whose PR was merged/closed, so it stays light.
const RECENT_FIELDS = 'number,title,url,isDraft,state,headRefName,baseRefName,author,mergeStateStatus,isCrossRepository';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function ghJson(root: string, args: string[]): Promise<any[]> {
  const { stdout } = await exec('gh', args, root, 90_000);
  const parsed = JSON.parse(stdout || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

function summariseChecks(rollup: any[] | undefined): CheckSummary {
  const summary: CheckSummary = { state: 'none', total: 0, passed: 0, failed: 0, pending: 0, failedNames: [] };
  for (const item of rollup ?? []) {
    summary.total++;
    if (item.__typename === 'StatusContext' || (item.state && !item.status)) {
      const state = String(item.state ?? '').toUpperCase();
      if (state === 'SUCCESS') {
        summary.passed++;
      } else if (state === 'FAILURE' || state === 'ERROR') {
        summary.failed++;
        summary.failedNames.push(String(item.context ?? 'status'));
      } else {
        summary.pending++;
      }
      continue;
    }
    const status = String(item.status ?? '').toUpperCase();
    const conclusion = String(item.conclusion ?? '').toUpperCase();
    if (status !== 'COMPLETED') {
      summary.pending++;
    } else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) {
      summary.passed++;
    } else {
      summary.failed++;
      summary.failedNames.push(String(item.name ?? 'check'));
    }
  }
  summary.state = summary.total === 0 ? 'none' : summary.failed > 0 ? 'failure' : summary.pending > 0 ? 'pending' : 'success';
  return summary;
}

function summariseReviews(raw: any): ReviewSummary {
  const author = String(raw.author?.login ?? '');
  // Reviews arrive oldest-first; only each reviewer's latest meaningful state counts.
  const latest = new Map<string, string>();
  for (const review of raw.reviews ?? []) {
    const login = String(review.author?.login ?? '');
    const state = String(review.state ?? '').toUpperCase();
    if (!login || login === author || state === 'PENDING') {
      continue;
    }
    if (state === 'DISMISSED') {
      latest.delete(login);
      continue;
    }
    const existing = latest.get(login);
    // A plain comment does not override an earlier approval / change request.
    if (state === 'COMMENTED' && (existing === 'APPROVED' || existing === 'CHANGES_REQUESTED')) {
      continue;
    }
    latest.set(login, state);
  }
  let approvals = 0;
  let changesRequested = 0;
  let commented = 0;
  for (const state of latest.values()) {
    if (state === 'APPROVED') {
      approvals++;
    } else if (state === 'CHANGES_REQUESTED') {
      changesRequested++;
    } else {
      commented++;
    }
  }
  const decisionRaw = String(raw.reviewDecision ?? '');
  const decision =
    decisionRaw === 'APPROVED' || decisionRaw === 'CHANGES_REQUESTED' || decisionRaw === 'REVIEW_REQUIRED'
      ? decisionRaw
      : changesRequested > 0
        ? 'CHANGES_REQUESTED'
        : approvals > 0
          ? 'APPROVED'
          : '';
  return {
    reviewers: latest.size,
    approvals,
    changesRequested,
    commented,
    requested: Array.isArray(raw.reviewRequests) ? raw.reviewRequests.length : 0,
    decision,
  };
}

function toPr(raw: any): PrInfo {
  return {
    number: raw.number,
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    state: (String(raw.state ?? 'OPEN').toUpperCase() as PrState),
    isDraft: !!raw.isDraft,
    headRefName: String(raw.headRefName ?? ''),
    baseRefName: String(raw.baseRefName ?? ''),
    author: String(raw.author?.login ?? ''),
    mergeStateStatus: String(raw.mergeStateStatus ?? ''),
    reviews: summariseReviews(raw),
    checks: summariseChecks(raw.statusCheckRollup),
  };
}

function friendlyError(err: unknown): string {
  if (err instanceof ExecError && err.code === 'ENOENT') {
    return 'GitHub CLI (gh) not found. Install it from https://cli.github.com, then run `gh auth login`.';
  }
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split('\n').find((l) => l.trim().length > 0) ?? message;
  if (/auth login|not logged in|authentication/i.test(message)) {
    return 'GitHub CLI is not signed in. Run `gh auth login` in a terminal.';
  }
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/** Fetches open PRs (with CI + reviews) and recent merged/closed PRs in as few gh calls as possible. */
export async function fetchGh(root: string): Promise<GhData> {
  const fetchedAt = Date.now();
  try {
    const [open, recent, me] = await Promise.all([
      ghJson(root, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', OPEN_FIELDS]),
      ghJson(root, ['pr', 'list', '--state', 'all', '--limit', '60', '--json', RECENT_FIELDS]).catch(() => [] as any[]),
      exec('gh', ['api', 'user', '--jq', '.login'], root)
        .then((r) => r.stdout.trim() || undefined)
        .catch(() => undefined),
    ]);
    const byNumber = new Map<number, PrInfo>();
    for (const raw of recent) {
      if (!raw.isCrossRepository) {
        byNumber.set(raw.number, toPr(raw));
      }
    }
    for (const raw of open) {
      if (!raw.isCrossRepository) {
        byNumber.set(raw.number, toPr(raw));
      }
    }
    return { prs: [...byNumber.values()], me, fetchedAt };
  } catch (err) {
    return { prs: [], error: friendlyError(err), fetchedAt };
  }
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title url state isDraft merged bodyHTML createdAt updatedAt
      author{login}
      baseRefName headRefName reviewDecision mergeable mergeStateStatus
      additions deletions changedFiles
      labels(first:20){nodes{name color}}
      reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name}}}}
      reviews(last:50){nodes{author{login} state submittedAt bodyHTML url
        comments(first:30){nodes{path line originalLine bodyHTML url}}}}
      comments(last:50){nodes{author{login} createdAt bodyHTML url}}
      allCommits: commits(last:100){nodes{commit{oid abbreviatedOid messageHeadline authoredDate url author{name}}}}
      files(first:100){nodes{path additions deletions changeType}}
      headCommit: commits(last:1){nodes{commit{statusCheckRollup{state
        contexts(first:100){nodes{__typename
          ... on CheckRun{name status conclusion detailsUrl}
          ... on StatusContext{context state targetUrl}}}}}}}
    }
  }
}`;

/** Everything the in-editor pull request panel shows, in one GraphQL call. bodyHTML is GitHub-sanitised. */
export async function fetchPrDetail(prUrl: string, cwd: string): Promise<any> {
  const url = new URL(prUrl);
  const [owner, name, , number] = url.pathname.split('/').filter(Boolean);
  if (!owner || !name || !number) {
    throw new Error(`Unrecognised pull request URL: ${prUrl}`);
  }
  const { stdout } = await exec(
    'gh',
    ['api', 'graphql', '--hostname', url.hostname, '-f', `query=${PR_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`],
    cwd,
    60_000
  );
  const json = JSON.parse(stdout);
  const pr = json.data?.repository?.pullRequest;
  if (!pr) {
    throw new Error(json.errors?.[0]?.message ?? 'Pull request not found');
  }
  return pr;
}
