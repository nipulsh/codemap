import * as vscode from 'vscode';
import { join } from 'node:path';
import { MessageBus } from './messageBus';
import { WorkerPool } from '../parser/workerPool';
import { ExplorerService } from '../explorer/ExplorerService';
import { normalizePath } from '../utils/path';
import { isSourceFile } from '../scanner/ignore';
import { basename } from 'node:path';

export class ArchitecturePanel {
  public static current: ArchitecturePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly bus: MessageBus;
  private readonly pool: WorkerPool;
  private readonly explorer: ExplorerService;
  private disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private busy = false;

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

    this.explorer = new ExplorerService(this.pool, (msg) => {
      if (msg.full) {
        this.bus.post({ type: 'graph:full', payload: msg.full });
      }
      if (msg.patch) {
        this.bus.post({ type: 'graph:patch', payload: msg.patch });
      }
      if (msg.progress && msg.progress.message) {
        this.bus.post({
          type: 'progress',
          payload: msg.progress,
        });
      }
      if (msg.error) {
        this.bus.post({ type: 'error', payload: msg.error });
      }
    });

    this.panel.webview.html = this.getHtml();

    this.disposables.push(
      this.bus.onMessage((msg) => {
        void this.handleWebviewMessage(msg);
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );

    this.setupWatcher();
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
    if (this.busy) {
      return;
    }
    this.busy = true;
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
      await this.explorer.refresh();
    } catch (err) {
      this.bus.post({
        type: 'error',
        payload: {
          message: err instanceof Error ? err.message : String(err),
          scope: 'architecture-panel',
        },
      });
    } finally {
      this.busy = false;
    }
  }

  async bootstrap(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
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
      await this.explorer.bootstrap(folders[0].uri.fsPath);
    } catch (err) {
      this.bus.post({
        type: 'error',
        payload: {
          message: err instanceof Error ? err.message : String(err),
          scope: 'architecture-panel',
        },
      });
    } finally {
      this.busy = false;
    }
  }

  private setupWatcher(): void {
    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onChange = (uri: vscode.Uri) => {
      void this.handleFsEvent(uri);
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(onChange);
    this.disposables.push(this.watcher);
  }

  private async handleFsEvent(uri: vscode.Uri): Promise<void> {
    const path = normalizePath(uri.fsPath);
    try {
      const stat = await vscode.workspace.fs.stat(uri).then(
        (s) => s,
        () => undefined,
      );
      if (stat?.type === vscode.FileType.Directory) {
        await this.explorer.onDirectoryChanged(path);
        return;
      }
      // Parent directory listing may need refresh for create/delete
      const parent = path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : path;
      if (!stat) {
        // deleted — invalidate parent folder + file
        await this.explorer.onFileChanged(path);
        await this.explorer.onDirectoryChanged(parent);
        return;
      }
      if (isSourceFile(basename(path)) || basename(path).includes('.')) {
        await this.explorer.onFileChanged(path);
        await this.explorer.onDirectoryChanged(parent);
      }
    } catch {
      // ignore watcher errors
    }
  }

  private async handleWebviewMessage(
    msg: import('../../shared/messages').WebviewToExtension,
  ): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          await this.bootstrap();
          break;
        case 'graph:refresh':
          await this.refresh();
          break;
        case 'folder:expand':
          await this.explorer.expandFolder(msg.payload.path);
          break;
        case 'folder:collapse':
          await this.explorer.collapseFolder(msg.payload.path);
          break;
        case 'file:expand':
          await this.explorer.expandFile(msg.payload.path);
          break;
        case 'file:collapse':
          await this.explorer.collapseFile(msg.payload.path);
          break;
        case 'function:expand':
          await this.explorer.expandFunction(msg.payload.nodeId);
          break;
        case 'function:collapse':
          await this.explorer.collapseFunction(msg.payload.nodeId);
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
          break;
      }
    } catch (err) {
      this.bus.post({
        type: 'error',
        payload: {
          message: err instanceof Error ? err.message : String(err),
          scope: 'architecture-panel',
        },
      });
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
    this.explorer.dispose();
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
