import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { fetchPrDetail } from './github';
import { PrSection, renderError, renderLoading, renderPr } from './prRender';

const panels = new Map<string, PrPanel>();

class PrPanel {
  private readonly panel: vscode.WebviewPanel;
  private section: PrSection = 'top';

  constructor(private readonly key: string, private readonly root: string, private readonly url: string, private readonly number: number) {
    this.panel = vscode.window.createWebviewPanel('gitBranchViewer.pullRequest', `#${number}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => panels.delete(key));
    this.panel.webview.onDidReceiveMessage((msg: { type: string; url?: string }) => {
      if (msg.type === 'refresh') {
        void this.load(this.section);
      } else if (msg.type === 'browser') {
        void vscode.env.openExternal(vscode.Uri.parse(this.url));
      } else if (msg.type === 'open' && msg.url && /^https?:\/\//i.test(msg.url)) {
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
    });
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  async load(section: PrSection): Promise<void> {
    this.section = section;
    const nonce = crypto.randomBytes(16).toString('base64');
    this.panel.webview.html = renderLoading(nonce);
    try {
      const pr = await fetchPrDetail(this.url, this.root);
      this.panel.title = `#${pr.number} ${pr.title}`;
      this.panel.webview.html = renderPr(pr, section, crypto.randomBytes(16).toString('base64'));
    } catch (e) {
      this.panel.webview.html = renderError(crypto.randomBytes(16).toString('base64'), e instanceof Error ? e.message : String(e));
    }
  }
}

/** Opens (or re-focuses) the pull request in an editor tab, scrolled to `section`. Data is re-fetched each time. */
export async function showPullRequest(root: string, url: string, number: number, section: PrSection = 'top'): Promise<void> {
  const key = `${root}#${number}`;
  let panel = panels.get(key);
  if (panel) {
    panel.reveal();
  } else {
    panel = new PrPanel(key, root, url, number);
    panels.set(key, panel);
  }
  await panel.load(section);
}
