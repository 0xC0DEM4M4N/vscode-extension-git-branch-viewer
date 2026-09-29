import * as vscode from 'vscode';
import { divergence, listCommits } from './git';
import { BranchInfo, CiState, CommitInfo, PrInfo, RepoSnapshot } from './model';

export type GroupId = 'current' | 'prs' | 'local' | 'closed';

export class RepoNode {
  readonly kind = 'repo' as const;
  constructor(readonly snap: RepoSnapshot) {}
}

export class GroupNode {
  readonly kind = 'group' as const;
  constructor(
    readonly snap: RepoSnapshot,
    readonly id: GroupId,
    readonly label: string,
    readonly branches: BranchInfo[]
  ) {}
}

export class BranchNode {
  readonly kind = 'branch' as const;
  constructor(readonly snap: RepoSnapshot, readonly branch: BranchInfo) {}
}

export class DetailNode {
  readonly kind = 'detail' as const;
  constructor(
    readonly snap: RepoSnapshot,
    readonly branch: BranchInfo,
    readonly key: string,
    readonly label: string,
    readonly description: string,
    readonly icon: vscode.ThemeIcon,
    readonly tooltip?: string,
    readonly command?: vscode.Command
  ) {}
}

export class CommitsNode {
  readonly kind = 'commits' as const;
  constructor(readonly snap: RepoSnapshot, readonly branch: BranchInfo) {}
}

export class CommitNode {
  readonly kind = 'commit' as const;
  constructor(readonly snap: RepoSnapshot, readonly branch: BranchInfo, readonly commit: CommitInfo) {}
}

export class MoreNode {
  readonly kind = 'more' as const;
  constructor(readonly key: string, readonly label: string) {}
}

export class MessageNode {
  readonly kind = 'message' as const;
  constructor(
    readonly key: string,
    readonly label: string,
    readonly icon: vscode.ThemeIcon,
    readonly tooltip?: string,
    readonly command?: vscode.Command
  ) {}
}

export type TreeNode = RepoNode | GroupNode | BranchNode | DetailNode | CommitsNode | CommitNode | MoreNode | MessageNode;

export const commitsKey = (snap: RepoSnapshot, b: BranchInfo) => `${snap.root}:${b.remoteOnly ? 'remote:' : ''}${b.name}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function relativeTime(date?: Date): string {
  if (!date) {
    return '';
  }
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      return `${plural(Math.floor(seconds / size), name)} ago`;
    }
  }
  return 'just now';
}

const escapeMd = (text: string) => text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
const baseShort = (snap: RepoSnapshot) => (snap.baseRef ?? 'main').replace(/^origin\//, '');

function ciColor(state: CiState): vscode.ThemeColor | undefined {
  switch (state) {
    case 'success':
      return new vscode.ThemeColor('testing.iconPassed');
    case 'failure':
      return new vscode.ThemeColor('testing.iconFailed');
    case 'pending':
      return new vscode.ThemeColor('charts.yellow');
    default:
      return undefined;
  }
}

function branchIcon(b: BranchInfo): vscode.ThemeIcon {
  const pr = b.pr;
  if (!pr) {
    return new vscode.ThemeIcon('git-branch');
  }
  if (pr.state === 'MERGED') {
    return new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('charts.purple'));
  }
  if (pr.state === 'CLOSED') {
    return new vscode.ThemeIcon('git-pull-request-closed', new vscode.ThemeColor('charts.red'));
  }
  if (pr.isDraft) {
    return new vscode.ThemeIcon('git-pull-request-draft', new vscode.ThemeColor('descriptionForeground'));
  }
  return new vscode.ThemeIcon('git-pull-request', ciColor(pr.checks.state));
}

function ciLabel(pr: PrInfo): string {
  switch (pr.checks.state) {
    case 'success':
      return '✓ CI';
    case 'failure':
      return `✗ CI ${pr.checks.failed}/${pr.checks.total}`;
    case 'pending':
      return '● CI running';
    default:
      return '';
  }
}

function reviewsLabel(pr: PrInfo): string {
  const r = pr.reviews;
  const breakdown = [r.approvals ? `${r.approvals}✓` : '', r.changesRequested ? `${r.changesRequested}✗` : ''].filter(Boolean).join(' ');
  return `${plural(r.reviewers, 'review')}${breakdown ? ` (${breakdown})` : ''}`;
}

function branchDescription(snap: RepoSnapshot, b: BranchInfo): string {
  const parts: string[] = [];
  const pr = b.pr;
  if (pr) {
    parts.push(`#${pr.number}`);
    if (pr.state === 'OPEN') {
      if (pr.isDraft) {
        parts.push('draft');
      }
      const ci = ciLabel(pr);
      if (ci) {
        parts.push(ci);
      }
      parts.push(reviewsLabel(pr));
    } else {
      parts.push(pr.state.toLowerCase());
    }
  }
  if (b.remoteOnly) {
    parts.push('remote only');
  } else if (b.behindBase && b.behindBase > 0 && b.name !== baseShort(snap)) {
    parts.push(`↓${b.behindBase} behind ${baseShort(snap)}`);
  }
  return parts.join(' · ');
}

function branchTooltip(snap: RepoSnapshot, b: BranchInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMd(b.name)}**${b.isCurrent ? ' _(current)_' : ''}\n\n`);
  if (b.pr) {
    const pr = b.pr;
    md.appendMarkdown(`#${pr.number} ${escapeMd(pr.title)} — ${pr.state.toLowerCase()}${pr.isDraft ? ', draft' : ''}\n\n`);
  }
  if (b.lastCommitSubject) {
    md.appendMarkdown(`${escapeMd(b.lastCommitSubject)}${b.lastCommitDate ? ` — ${relativeTime(b.lastCommitDate)}` : ''}`);
  }
  return md;
}

/** Branches that can never be deleted from the extension: the detected base branch plus the configured list. */
export function isProtectedBranch(snap: RepoSnapshot, name: string): boolean {
  const configured = vscode.workspace
    .getConfiguration('gitBranchViewer')
    .get<string[]>('protectedBranches', ['main', 'master', 'develop', 'dev', 'trunk']);
  return (!!snap.baseRef && name === baseShort(snap)) || configured.includes(name);
}

function contextValue(snap: RepoSnapshot, b: BranchInfo): string {
  return [
    'branch',
    b.isCurrent && 'current',
    isProtectedBranch(snap, b.name) && 'protected',
    !!snap.baseRef && b.name === baseShort(snap) && 'baseBranch',
    b.pr && 'hasPr',
    b.pr && b.pr.state !== 'OPEN' && 'prDone',
    b.remoteOnly && 'remoteOnly',
  ]
    .filter(Boolean)
    .join(' ');
}

export function groupBranches(snap: RepoSnapshot): GroupNode[] {
  const current = snap.branches.filter((b) => b.isCurrent);
  const rest = snap.branches.filter((b) => !b.isCurrent);
  const prs = rest.filter((b) => b.pr?.state === 'OPEN');
  const closed = rest.filter((b) => b.pr && b.pr.state !== 'OPEN');
  const local = rest.filter((b) => !b.pr);
  const groups: GroupNode[] = [];
  if (current.length) {
    groups.push(new GroupNode(snap, 'current', 'Current Branch', current));
  } else if (snap.detachedAt) {
    groups.push(new GroupNode(snap, 'current', `Detached HEAD at ${snap.detachedAt}`, []));
  }
  if (prs.length) {
    groups.push(new GroupNode(snap, 'prs', 'Open Pull Requests', prs));
  }
  if (local.length) {
    groups.push(new GroupNode(snap, 'local', 'Local Branches', local));
  }
  if (closed.length) {
    groups.push(new GroupNode(snap, 'closed', 'Merged / Closed', closed));
  }
  return groups;
}

function detailNodes(snap: RepoSnapshot, b: BranchInfo): DetailNode[] {
  const nodes: DetailNode[] = [];
  const pr = b.pr;

  if (pr) {
    const showPr = (section: string): vscode.Command => ({
      command: 'gitBranchViewer.showPr',
      title: 'Show pull request',
      arguments: [snap.root, pr.url, pr.number, section],
    });
    nodes.push(
      new DetailNode(
        snap,
        b,
        'pr',
        pr.title,
        `#${pr.number} ${pr.state.toLowerCase()}${pr.isDraft ? ' (draft)' : ''} → ${pr.baseRefName}`,
        new vscode.ThemeIcon('git-pull-request'),
        `Open #${pr.number} in VS Code`,
        showPr('top')
      )
    );
    if (pr.state === 'OPEN') {
      const c = pr.checks;
      const checksText =
        c.state === 'none'
          ? 'No checks'
          : c.state === 'failure'
            ? `${c.failed} failing, ${c.passed}/${c.total} passed`
            : c.state === 'pending'
              ? `${c.pending} running, ${c.passed}/${c.total} passed`
              : `All ${c.total} passed`;
      nodes.push(
        new DetailNode(
          snap,
          b,
          'checks',
          'Build',
          checksText,
          new vscode.ThemeIcon(
            c.state === 'success' ? 'pass' : c.state === 'failure' ? 'error' : c.state === 'pending' ? 'clock' : 'circle-outline',
            ciColor(c.state)
          ),
          c.failedNames.length ? `Failing: ${c.failedNames.join(', ')}. Click to see the checks.` : 'Show the checks in VS Code',
          showPr('checks')
        )
      );
      const r = pr.reviews;
      const reviewParts = [
        r.approvals ? `${r.approvals} approved` : '',
        r.changesRequested ? `${r.changesRequested} changes requested` : '',
        r.commented ? `${r.commented} commented` : '',
        r.requested ? `${r.requested} awaiting` : '',
      ].filter(Boolean);
      nodes.push(
        new DetailNode(
          snap,
          b,
          'reviews',
          'Reviews',
          `${plural(r.reviewers, 'review')}${reviewParts.length ? ` — ${reviewParts.join(', ')}` : ''}`,
          new vscode.ThemeIcon(
            r.decision === 'APPROVED' ? 'pass' : r.decision === 'CHANGES_REQUESTED' ? 'request-changes' : 'eye',
            r.decision === 'APPROVED'
              ? new vscode.ThemeColor('testing.iconPassed')
              : r.decision === 'CHANGES_REQUESTED'
                ? new vscode.ThemeColor('testing.iconFailed')
                : undefined
          ),
          r.decision ? `Review decision: ${r.decision.toLowerCase().replace(/_/g, ' ')}. Click to read the reviews.` : 'Show the reviews in VS Code',
          showPr('reviews')
        )
      );
    }
  }

  if (!b.remoteOnly && b.aheadBase !== undefined && b.behindBase !== undefined && snap.baseRef) {
    const behind = b.behindBase;
    nodes.push(
      new DetailNode(
        snap,
        b,
        'base',
        `vs ${snap.baseRef}`,
        behind === 0 && b.aheadBase === 0 ? 'identical' : `${b.aheadBase} ahead, ${behind} behind`,
        new vscode.ThemeIcon('git-compare', behind > 0 ? new vscode.ThemeColor('charts.yellow') : undefined),
        behind > 0 ? 'Behind the base branch: use the rebase button to bring it up to date' : 'Up to date with the base branch'
      )
    );
  }

  if (!b.remoteOnly) {
    const remoteText = !b.upstream
      ? 'not pushed'
      : b.upstreamGone
        ? `${b.upstream} (deleted on remote)`
        : b.ahead === 0 && b.behind === 0
          ? `${b.upstream} (in sync)`
          : `${b.upstream}: ${b.ahead} to push, ${b.behind} to pull`;
    nodes.push(new DetailNode(snap, b, 'remote', 'Remote', remoteText, new vscode.ThemeIcon('cloud')));
  }

  return nodes;
}

export class BranchTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  snapshots: RepoSnapshot[] = [];

  setSnapshots(snapshots: RepoSnapshot[]): void {
    this.snapshots = snapshots;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'repo': {
        const item = new vscode.TreeItem(node.snap.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `repo:${node.snap.root}`;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.description = node.snap.currentBranch ?? node.snap.detachedAt;
        item.tooltip = node.snap.root;
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(
          node.label,
          node.branches.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );
        item.id = `group:${node.snap.root}:${node.id}`;
        item.description = node.branches.length && node.id !== 'current' ? String(node.branches.length) : undefined;
        item.iconPath = new vscode.ThemeIcon(
          node.id === 'current' ? 'target' : node.id === 'prs' ? 'git-pull-request' : node.id === 'closed' ? 'archive' : 'git-branch'
        );
        return item;
      }
      case 'branch': {
        const b = node.branch;
        const item = new vscode.TreeItem(
          b.name,
          b.isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `branch:${node.snap.root}:${b.remoteOnly ? 'remote:' : ''}${b.name}`;
        item.description = branchDescription(node.snap, b);
        item.iconPath = branchIcon(b);
        item.contextValue = contextValue(node.snap, b);
        item.tooltip = branchTooltip(node.snap, b);
        return item;
      }
      case 'detail': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `detail:${node.snap.root}:${node.branch.remoteOnly ? 'remote:' : ''}${node.branch.name}:${node.key}`;
        item.description = node.description;
        item.iconPath = node.icon;
        item.tooltip = node.tooltip;
        item.command = node.command;
        item.contextValue = 'detail';
        return item;
      }
      case 'commits': {
        const b = node.branch;
        const item = new vscode.TreeItem('Commits', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `commits:${commitsKey(node.snap, b)}`;
        item.iconPath = new vscode.ThemeIcon('history');
        item.description =
          b.aheadBase !== undefined && b.aheadBase > 0 ? `${plural(b.aheadBase, 'commit')} not in ${baseShort(node.snap)}` : 'recent history';
        item.contextValue = 'commits';
        return item;
      }
      case 'commit': {
        const c = node.commit;
        const item = new vscode.TreeItem(c.subject || '(no message)', vscode.TreeItemCollapsibleState.None);
        item.id = `commit:${commitsKey(node.snap, node.branch)}:${c.hash}`;
        item.description = [c.short, c.author, relativeTime(c.date), c.unpushed ? 'not pushed' : ''].filter(Boolean).join(' · ');
        item.iconPath = c.isMerge
          ? new vscode.ThemeIcon('git-merge')
          : new vscode.ThemeIcon('git-commit', c.unpushed ? new vscode.ThemeColor('charts.yellow') : undefined);
        item.contextValue = 'commit';
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${escapeMd(c.subject)}**\n\n\`${c.hash}\`\n\n${escapeMd(c.author)}${c.date ? ` — ${c.date.toLocaleString()}` : ''}`);
        if (c.unpushed) {
          md.appendMarkdown('\n\n_Not pushed to the remote yet._');
        }
        item.tooltip = md;
        item.command = { command: 'gitBranchViewer.showCommit', title: 'Show commit', arguments: [node.snap.root, c.hash, c.short] };
        return item;
      }
      case 'more': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `more:${node.key}`;
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.command = { command: 'gitBranchViewer.loadMoreCommits', title: 'Show more', arguments: [node.key] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `message:${node.key}`;
        item.iconPath = node.icon;
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
    }
  }

  getChildren(node?: TreeNode): TreeNode[] | Promise<TreeNode[]> {
    if (!node) {
      if (this.snapshots.length === 1) {
        return this.repoChildren(this.snapshots[0]);
      }
      return this.snapshots.map((snap) => new RepoNode(snap));
    }
    switch (node.kind) {
      case 'repo':
        return this.repoChildren(node.snap);
      case 'group':
        return node.branches.map((b) => new BranchNode(node.snap, b));
      case 'branch':
        return [...detailNodes(node.snap, node.branch), new CommitsNode(node.snap, node.branch)];
      case 'commits':
        return this.commitChildren(node);
      default:
        return [];
    }
  }

  private readonly commitLimits = new Map<string, number>();

  private pageSize(): number {
    return Math.max(10, vscode.workspace.getConfiguration('gitBranchViewer').get<number>('commitsPageSize', 100));
  }

  showMoreCommits(key: string): void {
    this.commitLimits.set(key, (this.commitLimits.get(key) ?? this.pageSize()) + this.pageSize());
    this.emitter.fire(undefined);
  }

  /** Commits unique to the branch (base..branch); branches with none of their own show recent history instead. */
  private async commitChildren(node: CommitsNode): Promise<TreeNode[]> {
    const { snap, branch } = node;
    const key = commitsKey(snap, branch);
    const pageSize = this.pageSize();
    const limit = this.commitLimits.get(key) ?? pageSize;
    const ref = branch.remoteOnly ? `refs/remotes/origin/${branch.name}` : `refs/heads/${branch.name}`;

    try {
      let range = ref;
      if (snap.baseRef && branch.name !== baseShort(snap)) {
        const ahead = branch.aheadBase ?? (await divergence(snap.root, snap.baseRef, ref))?.ahead ?? 0;
        if (ahead > 0) {
          range = `${snap.baseRef}..${ref}`;
        }
      }
      const unpushedRange =
        !branch.remoteOnly && branch.upstream && !branch.upstreamGone && branch.ahead > 0 ? `${branch.upstream}..${ref}` : undefined;
      const { commits, hasMore } = await listCommits(snap.root, range, limit, unpushedRange);
      if (commits.length === 0) {
        return [new MessageNode(`nocommits:${key}`, 'No commits', new vscode.ThemeIcon('info'))];
      }
      const nodes: TreeNode[] = commits.map((c) => new CommitNode(snap, branch, c));
      if (hasMore) {
        nodes.push(new MoreNode(key, `Show ${pageSize} more commits...`));
      }
      return nodes;
    } catch (e) {
      return [
        new MessageNode(
          `commiterr:${key}`,
          'Could not read commits (try Fetch)',
          new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')),
          e instanceof Error ? e.message : String(e)
        ),
      ];
    }
  }

  private repoChildren(snap: RepoSnapshot): TreeNode[] {
    const nodes: TreeNode[] = [];
    if (snap.rebaseInProgress) {
      nodes.push(
        new MessageNode(
          `rebase:${snap.root}`,
          'Rebase in progress — resolve conflicts',
          new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange')),
          'Resolve the conflicts in Source Control, then continue the rebase (or run "Git Branch Viewer: Abort Rebase in Progress").',
          { command: 'workbench.view.scm', title: 'Open Source Control' }
        )
      );
    }
    if (snap.ghError) {
      nodes.push(
        new MessageNode(
          `gh:${snap.root}`,
          `GitHub: ${snap.ghError}`,
          new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')),
          'Pull request, build and review info is unavailable. Local branches are still shown. Click to retry.',
          { command: 'gitBranchViewer.refresh', title: 'Retry' }
        )
      );
    }
    if (!snap.baseRef) {
      nodes.push(
        new MessageNode(
          `base:${snap.root}`,
          'Could not find a main/master branch',
          new vscode.ThemeIcon('info'),
          'Set "gitBranchViewer.baseBranch" so Rebase Onto Main knows where to rebase.',
          { command: 'workbench.action.openSettings', title: 'Open Settings', arguments: ['gitBranchViewer.baseBranch'] }
        )
      );
    }
    return [...nodes, ...groupBranches(snap)];
  }
}
