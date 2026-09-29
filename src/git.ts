import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CommitInfo } from './model';

export class ExecError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell (no injection through branch names) and never prompts. */
export function exec(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            reject(new ExecError(`${cmd} was not found on your PATH`, 'ENOENT'));
            return;
          }
          const msg = (stderr || stdout || e.message || '').toString().trim();
          reject(new ExecError(msg || String(err), String(e.code ?? '')));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
  });
}

export async function git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  return (await exec('git', args, cwd, timeoutMs)).stdout.trim();
}

export async function resolveRoot(folder: string): Promise<{ root: string; gitDir: string } | undefined> {
  try {
    const out = await git(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
    const [root, gitDir] = out.split('\n');
    if (!root || !gitDir) {
      return undefined;
    }
    return { root, gitDir };
  } catch {
    return undefined;
  }
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Finds the branch to compare against / rebase onto. */
export async function detectBase(root: string, override: string): Promise<string | undefined> {
  const wanted = override.trim();
  if (wanted) {
    for (const candidate of [`origin/${wanted.replace(/^origin\//, '')}`, wanted]) {
      if (await refExists(root, candidate)) {
        return candidate;
      }
    }
  }
  try {
    const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head && (await refExists(root, head))) {
      return head;
    }
  } catch {
    // origin/HEAD not set, fall through
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(root, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function currentBranch(root: string): Promise<{ name?: string; detachedAt?: string }> {
  try {
    const name = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (name) {
      return { name };
    }
  } catch {
    // detached HEAD
  }
  try {
    return { detachedAt: await git(root, ['rev-parse', '--short', 'HEAD']) };
  } catch {
    return {};
  }
}

export interface RawBranch {
  name: string;
  upstream?: string;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  subject: string;
  date?: Date;
}

export async function listLocalBranches(root: string): Promise<RawBranch[]> {
  const format = ['%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:iso-strict)', '%(subject)'].join('%1f');
  const { stdout } = await exec('git', ['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads'], root);
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, upstream, track, date, ...rest] = line.split('\x1f');
      const ahead = /ahead (\d+)/.exec(track ?? '');
      const behind = /behind (\d+)/.exec(track ?? '');
      const parsed = date ? new Date(date) : undefined;
      return {
        name,
        upstream: upstream || undefined,
        upstreamGone: (track ?? '').includes('gone'),
        ahead: ahead ? Number(ahead[1]) : 0,
        behind: behind ? Number(behind[1]) : 0,
        subject: rest.join('\x1f'),
        date: parsed && !isNaN(parsed.getTime()) ? parsed : undefined,
      };
    });
}

/** How far `branch` has diverged from `base`: behind = commits only on base, ahead = commits only on branch. */
export async function divergence(root: string, base: string, branch: string): Promise<{ ahead: number; behind: number } | undefined> {
  try {
    const out = await git(root, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
    const [behind, ahead] = out.split(/\s+/).map(Number);
    if (Number.isNaN(behind) || Number.isNaN(ahead)) {
      return undefined;
    }
    return { ahead, behind };
  } catch {
    return undefined;
  }
}

export async function isDirty(root: string): Promise<boolean> {
  const out = await git(root, ['status', '--porcelain', '--untracked-files=no']);
  return out.length > 0;
}

export function isRebaseInProgress(gitDir: string): boolean {
  return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
}

/** https://host/owner/repo for a GitHub-style remote, whatever protocol it is configured with. */
export async function remoteWebUrl(root: string, remote = 'origin'): Promise<string | undefined> {
  try {
    const url = await git(root, ['remote', 'get-url', remote]);
    const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)([^/:]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
    return match ? `https://${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/** Lists up to `limit` commits in `range` (newest first) and whether more exist. */
export async function listCommits(
  root: string,
  range: string,
  limit: number,
  unpushedRange?: string
): Promise<{ commits: CommitInfo[]; hasMore: boolean }> {
  const format = ['%H', '%h', '%an', '%aI', '%P', '%s'].join('%x1f');
  const { stdout } = await exec('git', ['log', `-n${limit + 1}`, `--format=${format}`, range, '--'], root);
  const lines = stdout.split('\n').filter((l) => l.length > 0);

  const unpushed = new Set<string>();
  if (unpushedRange) {
    try {
      for (const hash of (await git(root, ['rev-list', unpushedRange])).split('\n')) {
        if (hash) {
          unpushed.add(hash);
        }
      }
    } catch {
      // upstream ref missing: treat everything as pushed
    }
  }

  const commits = lines.slice(0, limit).map((line): CommitInfo => {
    const [hash, short, author, date, parents, ...subject] = line.split('\x1f');
    const parsed = date ? new Date(date) : undefined;
    return {
      hash,
      short,
      author,
      date: parsed && !isNaN(parsed.getTime()) ? parsed : undefined,
      subject: subject.join('\x1f'),
      isMerge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1,
      unpushed: unpushed.has(hash),
    };
  });
  return { commits, hasMore: lines.length > limit };
}

export interface RemoteBranch {
  remote: string;
  name: string;
}

/** Where a local branch lives on a remote: its upstream if set, otherwise origin/<same name>. */
export async function findRemoteBranch(
  root: string,
  branch: { name: string; upstream?: string; upstreamGone: boolean }
): Promise<RemoteBranch | undefined> {
  if (branch.upstream && !branch.upstreamGone) {
    const slash = branch.upstream.indexOf('/');
    if (slash > 0 && (await refExists(root, `refs/remotes/${branch.upstream}`))) {
      return { remote: branch.upstream.slice(0, slash), name: branch.upstream.slice(slash + 1) };
    }
  }
  if (await refExists(root, `refs/remotes/origin/${branch.name}`)) {
    return { remote: 'origin', name: branch.name };
  }
  return undefined;
}

export async function deleteLocalBranch(root: string, name: string, force: boolean): Promise<void> {
  await git(root, ['branch', force ? '-D' : '-d', '--', name]);
}

export async function deleteRemoteBranch(root: string, remote: string, name: string): Promise<void> {
  await git(root, ['push', remote, '--delete', name], 120_000);
}
