/* eslint-disable @typescript-eslint/no-explicit-any */
// Pure HTML rendering for the pull request panel (no vscode import, so it can be tested on its own).

export type PrSection = 'top' | 'description' | 'checks' | 'reviews' | 'conversation' | 'commits' | 'files';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

const nodes = (connection: any): any[] => (Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : []);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');
const safeUrl = (url: unknown) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? esc(url) : '');

/** GitHub sanitises bodyHTML server side; the CSP below still forbids scripts, so this is defence in depth. */
const md = (html: unknown, empty = 'No description provided.') =>
  typeof html === 'string' && html.trim() ? `<div class="md">${html}</div>` : `<p class="muted">${esc(empty)}</p>`;

const MERGE_STATE: Record<string, [string, string]> = {
  CLEAN: ['Ready to merge', 'ok'],
  UNSTABLE: ['Checks failing', 'bad'],
  BLOCKED: ['Blocked', 'warn'],
  BEHIND: ['Behind base branch', 'warn'],
  DIRTY: ['Has merge conflicts', 'bad'],
  DRAFT: ['Draft', 'muted'],
  HAS_HOOKS: ['Ready to merge', 'ok'],
};

interface CheckRow {
  name: string;
  state: 'pass' | 'fail' | 'pending';
  detail: string;
  url: string;
}

function checkRows(pr: any): CheckRow[] {
  const contexts = nodes(nodes(pr.headCommit)[0]?.commit?.statusCheckRollup?.contexts);
  return contexts.map((c): CheckRow => {
    if (c.__typename === 'CheckRun') {
      const status = String(c.status ?? '').toUpperCase();
      const conclusion = String(c.conclusion ?? '').toUpperCase();
      const state = status !== 'COMPLETED' ? 'pending' : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) ? 'pass' : 'fail';
      return { name: c.name, state, detail: status !== 'COMPLETED' ? status.toLowerCase().replace(/_/g, ' ') : conclusion.toLowerCase().replace(/_/g, ' '), url: c.detailsUrl };
    }
    const s = String(c.state ?? '').toUpperCase();
    return { name: c.context, state: s === 'SUCCESS' ? 'pass' : s === 'FAILURE' || s === 'ERROR' ? 'fail' : 'pending', detail: s.toLowerCase(), url: c.targetUrl };
  });
}

const REVIEW_LABEL: Record<string, [string, string]> = {
  APPROVED: ['Approved', 'ok'],
  CHANGES_REQUESTED: ['Changes requested', 'bad'],
  COMMENTED: ['Commented', 'muted'],
  DISMISSED: ['Dismissed', 'muted'],
};

const CHANGE_TYPE: Record<string, string> = { ADDED: 'added', DELETED: 'deleted', RENAMED: 'renamed', MODIFIED: 'modified', COPIED: 'copied', CHANGED: 'changed' };

export function renderLoading(nonce: string): string {
  return page(nonce, '<p class="muted">Loading pull request...</p>', 'top');
}

export function renderError(nonce: string, message: string): string {
  return page(
    nonce,
    `<h1>Could not load the pull request</h1><pre class="err">${esc(message)}</pre>
     <p><button data-action="refresh">Try again</button> <button class="secondary" data-action="browser">Open in Browser</button></p>`,
    'top'
  );
}

export function renderPr(pr: any, section: PrSection, nonce: string): string {
  const state = pr.merged ? 'MERGED' : String(pr.state ?? 'OPEN').toUpperCase();
  const stateBadge = pr.isDraft && state === 'OPEN' ? ['Draft', 'muted'] : state === 'MERGED' ? ['Merged', 'merged'] : state === 'CLOSED' ? ['Closed', 'bad'] : ['Open', 'ok'];

  const checks = checkRows(pr);
  const failed = checks.filter((c) => c.state === 'fail').length;
  const pending = checks.filter((c) => c.state === 'pending').length;
  const passed = checks.length - failed - pending;
  const checksChip = checks.length === 0 ? '' : failed > 0 ? ['bad', `✗ ${failed} failing`] : pending > 0 ? ['warn', `● ${pending} running`] : ['ok', `✓ ${passed} passed`];

  const reviews = nodes(pr.reviews).filter((r) => r.state !== 'PENDING');
  const latest = new Map<string, string>();
  for (const r of reviews) {
    const login = r.author?.login;
    if (!login || login === pr.author?.login) continue;
    if (r.state === 'DISMISSED') latest.delete(login);
    else if (!(r.state === 'COMMENTED' && ['APPROVED', 'CHANGES_REQUESTED'].includes(latest.get(login) ?? ''))) latest.set(login, r.state);
  }
  const approvals = [...latest.values()].filter((s) => s === 'APPROVED').length;
  const changes = [...latest.values()].filter((s) => s === 'CHANGES_REQUESTED').length;
  const awaiting = nodes(pr.reviewRequests).map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name).filter(Boolean);
  const reviewsChip = ['muted', `${plural(latest.size, 'review')}${approvals ? ` · ${approvals}✓` : ''}${changes ? ` · ${changes}✗` : ''}`];
  const [mergeText, mergeKind] = MERGE_STATE[String(pr.mergeStateStatus ?? '')] ?? ['', ''];

  const chip = (target: string, c: string[] | string) =>
    Array.isArray(c) && c.length ? `<button class="chip ${esc(c[0])}" data-scroll="${target}">${esc(c[1])}</button>` : '';

  const labels = nodes(pr.labels)
    .map((l) => `<span class="label" style="--c:#${/^[0-9a-f]{6}$/i.test(l.color) ? l.color : '888888'}">${esc(l.name)}</span>`)
    .join('');

  const header = `
    <div class="toolbar"><button data-action="refresh">Refresh</button> <button class="secondary" data-action="browser">Open in Browser</button></div>
    <h1><span class="num">#${esc(pr.number)}</span> ${esc(pr.title)}</h1>
    <p class="meta">
      <span class="badge ${stateBadge[1]}">${stateBadge[0]}</span>
      <strong>${esc(pr.author?.login ?? 'unknown')}</strong> wants to merge <code>${esc(pr.headRefName)}</code> into <code>${esc(pr.baseRefName)}</code>
      · <span class="add">+${esc(pr.additions)}</span> <span class="del">−${esc(pr.deletions)}</span> in ${plural(Number(pr.changedFiles) || 0, 'file')}
      · updated ${esc(when(pr.updatedAt))}
    </p>
    <p class="chips">
      ${state === 'OPEN' && mergeText ? `<span class="chip static ${mergeKind}">${esc(mergeText)}</span>` : ''}
      ${chip('checks', checksChip)}${chip('reviews', reviewsChip)}${labels}
    </p>`;

  const checksHtml = checks.length
    ? `<ul class="rows">${checks
        .map(
          (c) => `<li class="${c.state}"><span class="icon">${c.state === 'pass' ? '✓' : c.state === 'fail' ? '✗' : '●'}</span><span class="grow">${esc(c.name)}</span><span class="muted">${esc(c.detail)}</span>${
            safeUrl(c.url) ? `<a href="${safeUrl(c.url)}">Details</a>` : ''
          }</li>`
        )
        .join('')}</ul>`
    : '<p class="muted">No checks have run on this pull request.</p>';

  const reviewsHtml =
    `${awaiting.length ? `<p class="muted">Awaiting review from: ${awaiting.map((a) => `<strong>${esc(a)}</strong>`).join(', ')}</p>` : ''}` +
    (reviews.length
      ? reviews
          .map((r) => {
            const [label, kind] = REVIEW_LABEL[r.state] ?? [r.state, 'muted'];
            const inline = nodes(r.comments)
              .map(
                (c) => `<div class="inline"><code>${esc(c.path)}${c.line ?? c.originalLine ? `:${esc(c.line ?? c.originalLine)}` : ''}</code>${md(c.bodyHTML, '')}</div>`
              )
              .join('');
            const hasBody = typeof r.bodyHTML === 'string' && r.bodyHTML.trim();
            return `<div class="card"><div class="cardhead"><strong>${esc(r.author?.login ?? 'ghost')}</strong> <span class="badge ${kind}">${esc(label)}</span><span class="muted grow right">${esc(when(r.submittedAt))}</span></div>${
              hasBody ? md(r.bodyHTML, '') : ''
            }${inline}</div>`;
          })
          .join('')
      : '<p class="muted">No reviews yet.</p>');

  const comments = nodes(pr.comments);
  const conversationHtml = comments.length
    ? comments
        .map(
          (c) => `<div class="card"><div class="cardhead"><strong>${esc(c.author?.login ?? 'ghost')}</strong><span class="muted grow right">${esc(when(c.createdAt))}</span></div>${md(c.bodyHTML, '')}</div>`
        )
        .join('')
    : '<p class="muted">No comments.</p>';

  const commits = nodes(pr.allCommits).map((n) => n.commit).filter(Boolean);
  const commitsHtml = commits.length
    ? `<ul class="rows">${commits
        .reverse()
        .map(
          (c) => `<li><span class="icon">◦</span><span class="grow">${esc(c.messageHeadline)}</span><span class="muted">${esc(c.author?.name ?? '')} · ${esc(when(c.authoredDate))}</span>${
            safeUrl(c.url) ? `<a href="${safeUrl(c.url)}"><code>${esc(c.abbreviatedOid)}</code></a>` : `<code>${esc(c.abbreviatedOid)}</code>`
          }</li>`
        )
        .join('')}</ul>`
    : '<p class="muted">No commits.</p>';

  const files = nodes(pr.files);
  const filesHtml = files.length
    ? `<ul class="rows">${files
        .map(
          (f) => `<li><span class="grow"><code>${esc(f.path)}</code> <span class="muted">${esc(CHANGE_TYPE[f.changeType] ?? '')}</span></span><span class="add">+${esc(f.additions)}</span><span class="del">−${esc(f.deletions)}</span></li>`
        )
        .join('')}${Number(pr.changedFiles) > files.length ? `<li class="muted">…and ${Number(pr.changedFiles) - files.length} more files (see the browser)</li>` : ''}</ul>`
    : '<p class="muted">No files.</p>';

  const body = `${header}
    <section id="description"><h2>Description</h2>${md(pr.bodyHTML)}</section>
    <section id="checks"><h2>Checks${checksChip ? ` <span class="count">${esc(checksChip[1])}</span>` : ''}</h2>${checksHtml}</section>
    <section id="reviews"><h2>Reviews <span class="count">${esc(reviewsChip[1])}</span></h2>${reviewsHtml}</section>
    <section id="conversation"><h2>Conversation <span class="count">${comments.length}</span></h2>${conversationHtml}</section>
    <section id="commits"><h2>Commits <span class="count">${commits.length}</span></h2>${commitsHtml}</section>
    <section id="files"><h2>Files changed <span class="count">${esc(pr.changedFiles)}</span></h2>${filesHtml}</section>`;
  return page(nonce, body, section);
}

const CSS = `
:root{--ok:var(--vscode-testing-iconPassed,#3fb950);--bad:var(--vscode-testing-iconFailed,#f85149);--warn:var(--vscode-charts-yellow,#d29922);--merged:var(--vscode-charts-purple,#a371f7)}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 20px 40px;max-width:980px;line-height:1.5}
h1{font-size:1.5em;margin:16px 0 6px;font-weight:600}h1 .num{color:var(--vscode-descriptionForeground);font-weight:400}
h2{font-size:1.1em;margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid var(--vscode-panel-border,#8884)}
section{margin:26px 0;scroll-margin-top:12px}
a{color:var(--vscode-textLink-foreground)}code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px;font-size:.92em}
pre{background:var(--vscode-textCodeBlock-background);padding:10px;border-radius:6px;overflow:auto}pre code{padding:0;background:none}
.err{white-space:pre-wrap;color:var(--bad)}.muted{color:var(--vscode-descriptionForeground)}.grow{flex:1}.right{text-align:right}.count{font-weight:400;color:var(--vscode-descriptionForeground);font-size:.9em}
.toolbar{display:flex;gap:8px;justify-content:flex-end;padding-top:12px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px;padding:4px 12px;cursor:pointer;font:inherit}
button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.meta{color:var(--vscode-descriptionForeground)}.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.badge,.chip,.label{display:inline-block;border-radius:999px;padding:1px 10px;font-size:.85em;border:1px solid currentColor}
.chip{background:none;cursor:pointer}.chip.static{cursor:default}.chip:hover:not(.static){background:var(--vscode-toolbar-hoverBackground)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.merged{color:var(--merged)}
.badge.muted,.chip.muted{color:var(--vscode-descriptionForeground)}
.label{color:var(--c);border-color:var(--c)}
.rows{list-style:none;margin:0;padding:0}.rows li{display:flex;gap:10px;align-items:baseline;padding:5px 4px;border-bottom:1px solid var(--vscode-panel-border,#8883)}
.rows .icon{width:1.2em;text-align:center}.rows li.pass .icon{color:var(--ok)}.rows li.fail .icon{color:var(--bad)}.rows li.pending .icon{color:var(--warn)}
.add{color:var(--ok)}.del{color:var(--bad)}
.card{border:1px solid var(--vscode-panel-border,#8886);border-radius:6px;margin:10px 0;padding:8px 12px}.cardhead{display:flex;gap:8px;align-items:center}
.inline{border-left:3px solid var(--vscode-panel-border,#8886);margin:8px 0;padding-left:10px}
.md img{max-width:100%}.md blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--vscode-panel-border,#8886);color:var(--vscode-descriptionForeground)}
.md table{border-collapse:collapse}.md th,.md td{border:1px solid var(--vscode-panel-border,#8886);padding:4px 8px}.md .task-list-item{list-style:none}
`;

function page(nonce: string, body: string, section: PrSection): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const scrollTo = (id) => { const el = id && id !== 'top' ? document.getElementById(id) : null; if (el) el.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0); };
document.addEventListener('click', (e) => {
  const scroll = e.target.closest('[data-scroll]'); if (scroll) { scrollTo(scroll.dataset.scroll); return; }
  const action = e.target.closest('[data-action]'); if (action) { vscode.postMessage({ type: action.dataset.action }); return; }
  const link = e.target.closest('a[href]'); if (link) { e.preventDefault(); vscode.postMessage({ type: 'open', url: link.href }); }
});
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'scroll') scrollTo(e.data.section); });
scrollTo(${JSON.stringify(section)});
</script></body></html>`;
}
