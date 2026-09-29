export type CiState = 'success' | 'failure' | 'pending' | 'none';
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface ReviewSummary {
  /** Distinct reviewers whose latest review is still in effect. */
  reviewers: number;
  approvals: number;
  changesRequested: number;
  commented: number;
  /** Reviewers (or teams) who have been asked to review but have not yet. */
  requested: number;
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';
}

export interface CheckSummary {
  state: CiState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failedNames: string[];
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string;
  mergeStateStatus: string;
  /** Only populated for open PRs (the list call for closed/merged PRs is kept light). */
  reviews: ReviewSummary;
  checks: CheckSummary;
}

export interface CommitInfo {
  hash: string;
  short: string;
  author: string;
  date?: Date;
  subject: string;
  isMerge: boolean;
  /** Not on the branch's upstream yet, so it exists only locally. */
  unpushed: boolean;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  /** True when the branch only exists on the remote (an open PR of yours with no local branch). */
  remoteOnly: boolean;
  upstream?: string;
  upstreamGone: boolean;
  /** Commits ahead / behind the upstream (what a push / pull would move). */
  ahead: number;
  behind: number;
  /** Commits ahead / behind the base branch (what a rebase would move). Undefined when unknown. */
  aheadBase?: number;
  behindBase?: number;
  lastCommitSubject: string;
  lastCommitDate?: Date;
  pr?: PrInfo;
}

export interface RepoSnapshot {
  root: string;
  gitDir: string;
  /** https://host/owner/repo, derived from the origin remote (used to link commits). */
  webUrl?: string;
  name: string;
  currentBranch?: string;
  detachedAt?: string;
  /** Resolved base ref, for example 'origin/main'. */
  baseRef?: string;
  branches: BranchInfo[];
  rebaseInProgress: boolean;
  /** Set when GitHub data could not be loaded (gh missing, not authenticated, no GitHub remote...). */
  ghError?: string;
  ghFetchedAt?: number;
}

export interface GhData {
  prs: PrInfo[];
  me?: string;
  error?: string;
  fetchedAt: number;
}
