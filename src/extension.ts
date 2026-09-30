import * as vscode from 'vscode';
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  divergence,
  exec,
  findRemoteBranch,
  git,
  isDirty,
  isRebaseInProgress,
  RemoteBranch,
  resolveRoot,
} from './git';
import { fetchGh } from './github';
import { BranchInfo, GhData, RepoSnapshot } from './model';
import { buildSnapshot } from './snapshot';
import { showPullRequest } from './prPanel';
import { PrSection } from './prRender';
import { BranchNode, BranchTreeProvider, CURRENT_SCHEME, isProtectedBranch, TreeNode } from './tree';

interface Target {
  snap: RepoSnapshot;
  branch: BranchInfo;
}

const VIEW_ID = 'gitBranchViewer.branches';
const CURRENT_VIEW_ID = 'gitBranchViewer.current';
const COMMIT_SCHEME = 'git-branch-viewer-commit';
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task));
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9._/@-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

class Controller implements vscode.Disposable {
  private chain: Promise<void> = Promise.resolve();
  private readonly gh = new Map<string, GhData>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private debounce?: NodeJS.Timeout;

  /** Called whenever fresh snapshots are published, so the UI can reflect the current branch in the section header. */
  onUpdate?: (snapshots: RepoSnapshot[]) => void;

  /** `providers[0]` is the main branch list; every provider receives the same snapshots. */
  constructor(readonly providers: BranchTreeProvider[]) {}

  get provider(): BranchTreeProvider {
    return this.providers[0];
  }

  private publish(snapshots: RepoSnapshot[]): void {
    for (const p of this.providers) {
      p.setSnapshots(snapshots);
    }
    this.onUpdate?.(snapshots);
  }

  /** Queues a refresh. `forceGh` bypasses the GitHub cache. */
  refresh(forceGh = false): Promise<void> {
    this.chain = this.chain.then(() => this.run(forceGh)).catch(() => undefined);
    return this.chain;
  }

  refreshSoon(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => void this.refresh(), 400);
  }

  private async discover(): Promise<{ root: string; gitDir: string }[]> {
    const found = new Map<string, { root: string; gitDir: string }>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const repo = await resolveRoot(folder.uri.fsPath);
      if (repo && !found.has(repo.root)) {
        found.set(repo.root, repo);
      }
    }
    return [...found.values()];
  }

  private syncWatchers(repos: { root: string; gitDir: string }[]): void {
    const wanted = new Set(repos.map((r) => r.root));
    for (const [root, disposable] of this.watchers) {
      if (!wanted.has(root)) {
        disposable.dispose();
        this.watchers.delete(root);
      }
    }
    for (const repo of repos) {
      if (this.watchers.has(repo.root)) {
        continue;
      }
      const pattern = new vscode.RelativePattern(vscode.Uri.file(repo.gitDir), '{HEAD,ORIG_HEAD,packed-refs,refs/**,rebase-merge/**,rebase-apply/**}');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const listeners = [
        watcher.onDidChange(() => this.refreshSoon()),
        watcher.onDidCreate(() => this.refreshSoon()),
        watcher.onDidDelete(() => this.refreshSoon()),
      ];
      this.watchers.set(repo.root, vscode.Disposable.from(watcher, ...listeners));
    }
  }

  private async run(forceGh: boolean): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitBranchViewer');
    const intervalMs = Math.max(30, cfg.get<number>('refreshIntervalSeconds', 120)) * 1000;
    const options = {
      baseOverride: cfg.get<string>('baseBranch', ''),
      showRemoteOnlyPrs: cfg.get<boolean>('showRemoteOnlyPrs', true),
    };

    await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, async () => {
      const repos = await this.discover();
      await vscode.commands.executeCommand('setContext', 'gitBranchViewer.noRepo', repos.length === 0);
      this.syncWatchers(repos);

      const build = async () => {
        const built = await Promise.all(
          repos.map((r) => buildSnapshot(r.root, r.gitDir, this.gh.get(r.root), options).catch(() => undefined))
        );
        return built.filter((s): s is RepoSnapshot => !!s);
      };

      // Paint local state straight away, then layer GitHub data on top once it arrives.
      this.publish(await build());

      const stale = repos.filter((r) => {
        const cached = this.gh.get(r.root);
        return forceGh || !cached || Date.now() - cached.fetchedAt > (cached.error ? 20_000 : intervalMs);
      });
      if (stale.length > 0) {
        await Promise.all(stale.map(async (r) => this.gh.set(r.root, await fetchGh(r.root))));
        this.publish(await build());
      }
    });
  }

  dispose(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    for (const w of this.watchers.values()) {
      w.dispose();
    }
    this.watchers.clear();
  }
}

async function resolveTarget(
  controller: Controller,
  node: TreeNode | undefined,
  placeHolder: string,
  filter: (b: BranchInfo) => boolean
): Promise<Target | undefined> {
  // Only the branch row itself is a valid target. A child row (details, commits) must never act on its parent branch.
  if (node) {
    return node.kind === 'branch' ? { snap: node.snap, branch: node.branch } : undefined;
  }
  const snapshots = controller.provider.snapshots;
  const items = snapshots.flatMap((snap) =>
    snap.branches
      .filter(filter)
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
      .map((branch) => ({
        label: branch.name,
        description: [snapshots.length > 1 ? snap.name : '', branch.isCurrent ? 'current' : '', branch.pr ? `#${branch.pr.number}` : '']
          .filter(Boolean)
          .join(' · '),
        target: { snap, branch } as Target,
      }))
  );
  if (items.length === 0) {
    void vscode.window.showInformationMessage('No matching branches found.');
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.target;
}

async function switchBranch(controller: Controller, node?: TreeNode): Promise<void> {
  const target = await resolveTarget(controller, node, 'Switch to which branch?', (b) => !b.isCurrent);
  if (!target) {
    return;
  }
  const { snap, branch } = target;
  if (snap.rebaseInProgress) {
    void vscode.window.showWarningMessage('A rebase is in progress. Finish or abort it before switching branches.');
    return;
  }
  try {
    await withProgress(`Switching to ${branch.name}...`, async () => {
      if (branch.remoteOnly && branch.pr) {
        await exec('gh', ['pr', 'checkout', String(branch.pr.number)], snap.root, 120_000);
      } else {
        await git(snap.root, ['switch', branch.name]);
      }
    });
    await controller.refresh();
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not switch to ${branch.name}: ${errorMessage(e)}`);
  }
}

async function rebaseOntoBase(controller: Controller, node?: TreeNode): Promise<void> {
  const target = await resolveTarget(controller, node, 'Rebase which branch?', (b) => !b.remoteOnly);
  if (!target) {
    return;
  }
  const { snap, branch } = target;
  const root = snap.root;
  const base = snap.baseRef;

  if (snap.rebaseInProgress) {
    void vscode.window.showWarningMessage('A rebase is already in progress. Finish or abort it first.');
    return;
  }
  if (!base) {
    void vscode.window.showErrorMessage('Could not find a main/master branch. Set "gitBranchViewer.baseBranch" in settings.');
    return;
  }
  if (branch.name === base.replace(/^origin\//, '')) {
    void vscode.window.showInformationMessage(`"${branch.name}" is the base branch, so there is nothing to rebase it onto.`);
    return;
  }

  let fetchWarning = '';
  if (base.startsWith('origin/')) {
    try {
      await withProgress('Fetching origin...', () => git(root, ['fetch', '--prune', 'origin'], 120_000));
    } catch (e) {
      fetchWarning = `\n\nCould not fetch from origin (${errorMessage(e).split('\n')[0]}), so the last known ${base} will be used.`;
    }
  }

  const div = await divergence(root, base, branch.name);
  if (!div) {
    void vscode.window.showErrorMessage(`Could not compare "${branch.name}" with ${base}.`);
    return;
  }
  if (div.behind === 0) {
    void vscode.window.showInformationMessage(`"${branch.name}" is already up to date with ${base}.`);
    await controller.refresh();
    return;
  }

  const dirty = await isDirty(root);
  if (dirty && !branch.isCurrent) {
    void vscode.window.showErrorMessage(
      `You have uncommitted changes. Commit or stash them, or switch to "${branch.name}" first, before rebasing it.`
    );
    return;
  }

  const pushed = !!branch.upstream && !branch.upstreamGone;
  const detail =
    `"${branch.name}" is ${div.behind} commit${div.behind === 1 ? '' : 's'} behind and ${div.ahead} ahead of ${base}.` +
    (dirty ? '\n\nYour uncommitted changes will be stashed and re-applied afterwards.' : '') +
    (pushed && div.ahead > 0 ? '\n\nThis rewrites history, so the branch will need a force push afterwards (you will be offered one).' : '') +
    fetchWarning;
  const label = dirty ? 'Rebase (stash changes)' : 'Rebase';
  const choice = await vscode.window.showWarningMessage(`Rebase "${branch.name}" onto ${base}?`, { modal: true, detail }, label);
  if (choice !== label) {
    return;
  }

  try {
    await withProgress(`Rebasing ${branch.name} onto ${base}...`, () =>
      git(root, ['rebase', ...(dirty ? ['--autostash'] : []), base, branch.name], 300_000)
    );
  } catch (e) {
    await controller.refresh();
    if (isRebaseInProgress(snap.gitDir)) {
      const action = await vscode.window.showWarningMessage(
        `Rebase of "${branch.name}" stopped because of conflicts. Resolve them in Source Control, then continue the rebase.`,
        'Open Source Control',
        'Abort Rebase'
      );
      if (action === 'Open Source Control') {
        await vscode.commands.executeCommand('workbench.view.scm');
      } else if (action === 'Abort Rebase') {
        await abortRebase(controller, snap);
      }
    } else {
      void vscode.window.showErrorMessage(`Rebase failed: ${errorMessage(e)}`);
    }
    return;
  }

  await controller.refresh();
  const done = `Rebased "${branch.name}" onto ${base}.${branch.isCurrent ? '' : ` You are now on "${branch.name}".`}`;
  if (pushed && div.ahead > 0 && branch.upstream) {
    const push = await vscode.window.showInformationMessage(
      done,
      'Force Push (with lease)'
    );
    if (push) {
      const slash = branch.upstream.indexOf('/');
      const remote = branch.upstream.slice(0, slash);
      const remoteBranch = branch.upstream.slice(slash + 1);
      try {
        await withProgress(`Pushing ${branch.name}...`, () =>
          git(root, ['push', '--force-with-lease', remote, `${branch.name}:${remoteBranch}`], 120_000)
        );
        void vscode.window.showInformationMessage(`Pushed "${branch.name}" to ${branch.upstream}.`);
        await controller.refresh(true);
      } catch (e) {
        void vscode.window.showErrorMessage(`Push failed: ${errorMessage(e)}`);
      }
    }
  } else {
    void vscode.window.showInformationMessage(done);
  }
}

interface DeleteTarget extends Target {
  remote?: RemoteBranch;
}

const baseNameOf = (snap: RepoSnapshot) => (snap.baseRef ?? '').replace(/^origin\//, '');

/** Why a branch can't be deleted, or undefined when it can. */
function undeletableReason(snap: RepoSnapshot, b: BranchInfo): string | undefined {
  if (b.remoteOnly) {
    return 'it has no local branch';
  }
  if (b.isCurrent) {
    return 'it is checked out (switch to another branch first)';
  }
  if (isProtectedBranch(snap, b.name)) {
    return 'it is a protected branch';
  }
  return undefined;
}

async function deleteBranches(controller: Controller, node?: TreeNode, selection?: TreeNode[]): Promise<void> {
  // Tree multi-select passes every selected node; the palette falls back to a multi-pick.
  const fromTree = (selection && selection.length > 0 ? selection : node ? [node] : []).filter(
    (n): n is BranchNode => n.kind === 'branch'
  );
  let candidates: Target[] = fromTree.map((n) => ({ snap: n.snap, branch: n.branch }));

  if (candidates.length === 0 && (node || (selection && selection.length > 0))) {
    return; // invoked from the tree on something that is not a branch row
  }
  if (candidates.length === 0) {
    const snapshots = controller.provider.snapshots;
    const items = snapshots.flatMap((snap) =>
      snap.branches
        .filter((b) => !undeletableReason(snap, b))
        .map((branch) => ({
          label: branch.name,
          description: [snapshots.length > 1 ? snap.name : '', branch.pr ? `#${branch.pr.number} ${branch.pr.state.toLowerCase()}` : '']
            .filter(Boolean)
            .join(' · '),
          target: { snap, branch } as Target,
        }))
    );
    if (items.length === 0) {
      void vscode.window.showInformationMessage('There are no branches that can be deleted.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Delete which branches?', canPickMany: true, matchOnDescription: true });
    if (!picked || picked.length === 0) {
      return;
    }
    candidates = picked.map((p) => p.target);
  }

  const skipped: string[] = [];
  const targets: DeleteTarget[] = [];
  for (const c of candidates) {
    const reason = undeletableReason(c.snap, c.branch);
    if (reason) {
      skipped.push(`"${c.branch.name}" (${reason})`);
    } else {
      targets.push({ ...c, remote: await findRemoteBranch(c.snap.root, c.branch) });
    }
  }
  if (targets.length === 0) {
    void vscode.window.showErrorMessage(`Nothing to delete: ${skipped.join(', ')}.`);
    return;
  }

  // Describe what would be lost so the confirmation is an informed one.
  const lines = targets.map(({ branch, remote }) => {
    const facts: string[] = [branch.pr ? `PR #${branch.pr.number} ${branch.pr.state.toLowerCase()}` : 'no PR'];
    if (branch.aheadBase) {
      facts.push(`${branch.aheadBase} commit${branch.aheadBase === 1 ? '' : 's'} not in ${baseNameOf(targets[0].snap) || 'base'}`);
    }
    if (branch.ahead > 0 && branch.upstream) {
      facts.push(`${branch.ahead} not pushed`);
    } else if (!remote && branch.aheadBase) {
      facts.push('never pushed: exists only here');
    }
    return `• ${branch.name} (${facts.join(', ')})`;
  });
  const shown = lines.length > 12 ? [...lines.slice(0, 12), `...and ${lines.length - 12} more`] : lines;
  const openPrs = targets.filter((t) => t.remote && t.branch.pr?.state === 'OPEN').map((t) => `#${t.branch.pr!.number}`);
  const withRemote = targets.filter((t) => t.remote);
  const detail =
    shown.join('\n') +
    (withRemote.length > 0 ? `\n\nOn the remote, ${withRemote.length} of these ${withRemote.length === 1 ? 'exists' : 'exist'} and can also be deleted.` : '') +
    (openPrs.length > 0 ? `\n\nDeleting the remote branch will close open pull request${openPrs.length === 1 ? '' : 's'} ${openPrs.join(', ')}.` : '') +
    (skipped.length > 0 ? `\n\nSkipped: ${skipped.join(', ')}.` : '');

  const localLabel = 'Delete Local';
  const allOrigin = withRemote.every((t) => t.remote!.remote === 'origin');
  const bothLabel = `Delete Local and ${allOrigin ? 'Origin' : 'Remote'}`;
  const choice = await vscode.window.showWarningMessage(
    targets.length === 1 ? `Delete branch "${targets[0].branch.name}"?` : `Delete ${targets.length} branches?`,
    { modal: true, detail },
    localLabel,
    ...(withRemote.length > 0 ? [bothLabel] : [])
  );
  if (!choice) {
    return;
  }
  const alsoRemote = choice === bothLabel;

  const deletedLocal: DeleteTarget[] = [];
  const needForce: DeleteTarget[] = [];
  const failures: string[] = [];

  await withProgress(targets.length === 1 ? `Deleting ${targets[0].branch.name}...` : `Deleting ${targets.length} branches...`, async () => {
    for (const t of targets) {
      try {
        await deleteLocalBranch(t.snap.root, t.branch.name, false);
        deletedLocal.push(t);
      } catch (e) {
        if (/not fully merged/i.test(errorMessage(e))) {
          needForce.push(t);
        } else {
          failures.push(`${t.branch.name}: ${errorMessage(e).split('\n')[0]}`);
        }
      }
    }
  });

  // Squash/rebase merges leave the branch "unmerged" as far as git can tell, so ask before forcing.
  if (needForce.length > 0) {
    const forceDetail = needForce
      .map(({ branch }) => {
        const why = branch.pr?.state === 'MERGED' ? 'its PR was merged (squash and rebase merges are not recognised by git)' : branch.pr ? `PR #${branch.pr.number} is ${branch.pr.state.toLowerCase()}` : 'no pull request';
        return `• ${branch.name}: ${why}`;
      })
      .join('\n');
    const force = await vscode.window.showWarningMessage(
      needForce.length === 1
        ? `"${needForce[0].branch.name}" is not fully merged. Delete it anyway?`
        : `${needForce.length} branches are not fully merged. Delete them anyway?`,
      { modal: true, detail: `${forceDetail}\n\nCommits only on these branches will be hard to recover.` },
      'Force Delete'
    );
    if (force) {
      for (const t of needForce) {
        try {
          await deleteLocalBranch(t.snap.root, t.branch.name, true);
          deletedLocal.push(t);
        } catch (e) {
          failures.push(`${t.branch.name}: ${errorMessage(e).split('\n')[0]}`);
        }
      }
    }
  }

  let deletedRemote = 0;
  if (alsoRemote) {
    await withProgress('Deleting from remote...', async () => {
      for (const t of deletedLocal) {
        if (!t.remote) {
          continue;
        }
        try {
          await deleteRemoteBranch(t.snap.root, t.remote.remote, t.remote.name);
          deletedRemote++;
        } catch (e) {
          const msg = errorMessage(e);
          if (/remote ref does not exist|unable to delete/i.test(msg) && /does not exist/i.test(msg)) {
            deletedRemote++; // already gone on the remote
          } else {
            failures.push(`${t.remote.remote}/${t.remote.name} (local copy was deleted): ${msg.split('\n').filter((l) => l.trim()).slice(-1)[0]}`);
          }
        }
      }
    });
  }

  const summary = `Deleted ${deletedLocal.length} local branch${deletedLocal.length === 1 ? '' : 'es'}${alsoRemote ? ` and ${deletedRemote} on the remote` : ''}.`;
  if (failures.length > 0) {
    void vscode.window.showWarningMessage(`${summary} Problems: ${failures.join('; ')}`);
  } else if (deletedLocal.length > 0) {
    void vscode.window.showInformationMessage(summary);
  }
  await controller.refresh(true);
}

async function abortRebase(controller: Controller, snap?: RepoSnapshot): Promise<void> {
  const repo = snap ?? controller.provider.snapshots.find((s) => s.rebaseInProgress);
  if (!repo) {
    void vscode.window.showInformationMessage('No rebase is in progress.');
    return;
  }
  try {
    await git(repo.root, ['rebase', '--abort']);
    void vscode.window.showInformationMessage('Rebase aborted.');
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not abort the rebase: ${errorMessage(e)}`);
  }
  await controller.refresh();
}

export function activate(context: vscode.ExtensionContext): void {
  // Two sections in the same sidebar container: the checked-out branch, and every other branch.
  const provider = new BranchTreeProvider('others');
  const currentProvider = new BranchTreeProvider('current');
  const controller = new Controller([provider, currentProvider]);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true });
  const currentView = vscode.window.createTreeView(CURRENT_VIEW_ID, { treeDataProvider: currentProvider, canSelectMany: true });
  const anyVisible = () => view.visible || currentView.visible;

  // The branch name sits next to the section title, so it is visible even when that section is collapsed.
  controller.onUpdate = (snapshots) => {
    currentView.description =
      snapshots.length === 1 ? snapshots[0].currentBranch ?? (snapshots[0].detachedAt ? `detached at ${snapshots[0].detachedAt}` : undefined) : undefined;
  };

  // Colours the current branch's label and adds a badge, the closest a tree row gets to "highlighted".
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) =>
        uri.scheme === CURRENT_SCHEME ? new vscode.FileDecoration('●', 'Current branch', new vscode.ThemeColor('charts.blue')) : undefined,
    })
  );

  const register = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('gitBranchViewer.refresh', () => controller.refresh(true));
  register('gitBranchViewer.fetch', async () => {
    const repos = provider.snapshots;
    try {
      await withProgress('Fetching from remote...', () => Promise.all(repos.map((s) => git(s.root, ['fetch', '--all', '--prune'], 120_000))));
    } catch (e) {
      void vscode.window.showWarningMessage(`Fetch failed: ${errorMessage(e).split('\n')[0]}`);
    }
    await controller.refresh(true);
  });
  register('gitBranchViewer.switchBranch', (node?: TreeNode) => switchBranch(controller, node));
  register('gitBranchViewer.rebaseOntoBase', (node?: TreeNode) => rebaseOntoBase(controller, node));
  register('gitBranchViewer.abortRebase', () => abortRebase(controller));
  register('gitBranchViewer.showPr', (root: string, url: string, number: number, section?: PrSection) =>
    showPullRequest(root, url, number, section ?? 'top')
  );
  register('gitBranchViewer.openPr', async (node?: TreeNode) => {
    const target = await resolveTarget(controller, node, 'Show which pull request?', (b) => !!b.pr);
    if (target?.branch.pr) {
      await showPullRequest(target.snap.root, target.branch.pr.url, target.branch.pr.number, 'top');
    }
  });
  register('gitBranchViewer.openPrInBrowser', async (node?: TreeNode) => {
    const target = await resolveTarget(controller, node, 'Open which pull request in the browser?', (b) => !!b.pr);
    if (target?.branch.pr) {
      await vscode.env.openExternal(vscode.Uri.parse(target.branch.pr.url));
    }
  });
  register('gitBranchViewer.openCommitInBrowser', async (node?: TreeNode) => {
    if (node?.kind === 'commit' && node.snap.webUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(`${node.snap.webUrl}/commit/${node.commit.hash}`));
    } else {
      void vscode.window.showInformationMessage('No GitHub URL could be worked out for this repository.');
    }
  });
  // Commits open as a readable diff inside VS Code, generated locally with `git show`.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(COMMIT_SCHEME, {
      async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const { root, hash } = JSON.parse(uri.query) as { root: string; hash: string };
        if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
          return 'Invalid commit hash.';
        }
        try {
          return (await exec('git', ['show', '--no-color', '--stat', '--patch', '--format=fuller', hash, '--'], root)).stdout;
        } catch (e) {
          return `Could not read commit ${hash}:\n${errorMessage(e)}`;
        }
      },
    })
  );
  register('gitBranchViewer.showCommit', async (root: string, hash: string, short: string) => {
    const uri = vscode.Uri.from({ scheme: COMMIT_SCHEME, path: `/${short}.diff`, query: JSON.stringify({ root, hash }) });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  register('gitBranchViewer.createPr', async (node?: TreeNode) => {
    const target = await resolveTarget(controller, node, 'Create a pull request for which branch?', (b) => !b.pr && !b.remoteOnly);
    if (!target) {
      return;
    }
    // Runs in a terminal because gh may need to ask about pushing the branch first.
    const terminal = vscode.window.createTerminal({ name: `PR: ${target.branch.name}`, cwd: target.snap.root });
    terminal.show();
    terminal.sendText(`gh pr create --web --head ${shellQuote(target.branch.name)}`);
  });
  register('gitBranchViewer.copyBranchName', async (node?: TreeNode) => {
    const target = await resolveTarget(controller, node, 'Copy which branch name?', () => true);
    if (target) {
      await vscode.env.clipboard.writeText(target.branch.name);
    }
  });
  register('gitBranchViewer.deleteBranch', (node?: TreeNode, selection?: TreeNode[]) => deleteBranches(controller, node, selection));
  register('gitBranchViewer.copyCommitHash', async (node?: TreeNode) => {
    if (node?.kind === 'commit') {
      await vscode.env.clipboard.writeText(node.commit.hash);
    }
  });
  register('gitBranchViewer.loadMoreCommits', (key: string) => controller.providers.forEach((p) => p.showMoreCommits(key)));
  register('gitBranchViewer.openUrl', (url: string) => vscode.env.openExternal(vscode.Uri.parse(url)));

  context.subscriptions.push(
    view,
    currentView,
    controller,
    view.onDidChangeVisibility((e) => e.visible && void controller.refresh()),
    currentView.onDidChangeVisibility((e) => e.visible && void controller.refresh()),
    vscode.window.onDidChangeWindowState((s) => s.focused && anyVisible() && void controller.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void controller.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitBranchViewer') && void controller.refresh(true))
  );

  // Cheap periodic poll: the GitHub cache TTL (refreshIntervalSeconds) decides whether gh is actually called.
  const timer = setInterval(() => {
    if (anyVisible() && vscode.window.state.focused) {
      void controller.refresh();
    }
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  void controller.refresh();
}

export function deactivate(): void {
  // nothing to clean up beyond subscriptions
}
