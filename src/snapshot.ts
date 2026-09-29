import * as path from 'path';
import { currentBranch, detectBase, divergence, isRebaseInProgress, listLocalBranches, remoteWebUrl } from './git';
import { BranchInfo, GhData, PrInfo, RepoSnapshot } from './model';

export interface SnapshotOptions {
  baseOverride: string;
  showRemoteOnlyPrs: boolean;
}

/** Picks the PR that best describes a branch: an open one wins over merged/closed history. */
function pickPr(branchName: string, prs: PrInfo[]): PrInfo | undefined {
  const candidates = prs.filter((pr) => pr.headRefName === branchName);
  return candidates.find((pr) => pr.state === 'OPEN') ?? candidates.sort((a, b) => b.number - a.number)[0];
}

export async function buildSnapshot(
  root: string,
  gitDir: string,
  gh: GhData | undefined,
  options: SnapshotOptions
): Promise<RepoSnapshot> {
  const [raw, current, baseRef, webUrl] = await Promise.all([
    listLocalBranches(root),
    currentBranch(root),
    detectBase(root, options.baseOverride),
    remoteWebUrl(root),
  ]);

  const branches: BranchInfo[] = await Promise.all(
    raw.map(async (r): Promise<BranchInfo> => {
      const versusBase = baseRef ? await divergence(root, baseRef, r.name) : undefined;
      return {
        name: r.name,
        isCurrent: r.name === current.name,
        remoteOnly: false,
        upstream: r.upstream,
        upstreamGone: r.upstreamGone,
        ahead: r.ahead,
        behind: r.behind,
        aheadBase: versusBase?.ahead,
        behindBase: versusBase?.behind,
        lastCommitSubject: r.subject,
        lastCommitDate: r.date,
        pr: gh ? pickPr(r.name, gh.prs) : undefined,
      };
    })
  );

  if (gh && options.showRemoteOnlyPrs && gh.me) {
    const local = new Set(branches.map((b) => b.name));
    for (const pr of gh.prs) {
      if (pr.state === 'OPEN' && pr.author === gh.me && !local.has(pr.headRefName)) {
        branches.push({
          name: pr.headRefName,
          isCurrent: false,
          remoteOnly: true,
          upstream: `origin/${pr.headRefName}`,
          upstreamGone: false,
          ahead: 0,
          behind: 0,
          lastCommitSubject: pr.title,
          pr,
        });
      }
    }
  }

  return {
    root,
    gitDir,
    webUrl,
    name: path.basename(root),
    currentBranch: current.name,
    detachedAt: current.detachedAt,
    baseRef,
    branches,
    rebaseInProgress: isRebaseInProgress(gitDir),
    ghError: gh?.error,
    ghFetchedAt: gh?.fetchedAt,
  };
}
