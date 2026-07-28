import * as vscode from 'vscode';
import { join } from 'node:path';
import { MessageBus } from './messageBus';
import { scanWorkspace } from '../scanner/workspaceScanner';
import { WorkerPool } from '../parser/workerPool';
import { InMemoryDependencyIndex } from '../cache/dependencyIndex';
import { generateGraph } from '../graph/generator';
import { normalizePath } from '../utils/path';

export class ArchitecturePanel {
  public static current: ArchitecturePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly bus: MessageBus;
  private readonly pool: WorkerPool;
  private readonly index = new InMemoryDependencyIndex();
  private disposables: vscode.Disposable[] = [];
  private scanning = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.panel = panel;
    this.bus = new MessageBus(panel.webview);
    this.pool = new WorkerPool({
      workerScript: join(
        extensionUri.fsPath,
        'out',
        'parser',
        'workers',
        'parseWorker.js',
      ),
    });

    this.panel.webview.html = this.getHtml();

    this.disposables.push(
      this.bus.onMessage((msg) => {
        void this.handleWebviewMessage(msg);
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  static createOrShow(extensionUri: vscode.Uri): ArchitecturePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ArchitecturePanel.current) {
      ArchitecturePanel.current.panel.reveal(column);
      return ArchitecturePanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'codemapArchitecture',
      'CodeMap Architecture',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
        ],
      },
    );

    ArchitecturePanel.current = new ArchitecturePanel(panel, extensionUri);
    return ArchitecturePanel.current;
  }

  async refresh(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;

    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        this.bus.post({
          type: 'error',
          payload: {
            message: 'No workspace folder open.',
            scope: 'scanner',
          },
        });
        return;
      }

      const workspaceRoot = folders[0].uri.fsPath;

      this.bus.post({
        type: 'progress',
        payload: { message: 'Scanning workspace…', percent: 5 },
      });

      const scan = scanWorkspace(workspaceRoot, (message, percent) => {
        this.bus.post({
          type: 'progress',
          payload: { message, percent },
        });
      });

      this.bus.post({
        type: 'progress',
        payload: {
          message: `Parsing ${scan.files.length} files…`,
          percent: 40,
        },
      });

      const results = await this.pool.parseFiles({
        workspaceRoot: scan.workspaceRoot,
        files: scan.files.map((f) => ({ absolutePath: f.absolutePath })),
        tsconfigs: scan.tsconfigs,
      });

      this.index.clear();
      const byPath = new Map(results.map((r) => [normalizePath(r.filePath), r]));

      for (const file of scan.files) {
        const parsed = byPath.get(normalizePath(file.absolutePath));
        this.index.set({
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
          contentHash: file.contentHash,
          mtimeMs: file.mtimeMs,
          imports: parsed?.imports ?? [],
          exports: parsed?.exports ?? [],
          dependencyPaths: parsed?.dependencyPaths ?? [],
          dynamicImportPaths: parsed?.dynamicImportPaths ?? [],
          parseError: parsed?.error,
        });
      }

      this.bus.post({
        type: 'progress',
        payload: { message: 'Building graph…', percent: 85 },
      });

      const snapshot = generateGraph({
        workspaceRoot: scan.workspaceRoot,
        files: this.index.all(),
      });

      this.bus.post({
        type: 'graph:full',
        payload: snapshot,
      });
    } catch (err) {
      this.bus.post({
        type: 'error',
        payload: {
          message: err instanceof Error ? err.message : String(err),
          scope: 'architecture-panel',
        },
      });
    } finally {
      this.scanning = false;
    }
  }

  private async handleWebviewMessage(
    msg: import('../../shared/messages').WebviewToExtension,
  ): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'graph:refresh':
        await this.refresh();
        break;
      case 'node:open': {
        const uri = vscode.Uri.file(msg.payload.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        if (msg.payload.line !== undefined) {
          const line = Math.max(0, msg.payload.line - 1);
          const pos = new vscode.Position(line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos));
        }
        break;
      }
      case 'node:select':
      case 'search:query':
      case 'filter:update':
        // Phase 3 — ignore silently (no fake results)
        break;
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'main.css'),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>CodeMap Architecture</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    ArchitecturePanel.current = undefined;
    void this.pool.dispose();
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
