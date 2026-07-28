import type { ExtensionToWebview, WebviewToExtension } from '../../shared/messages';
import {
  parseExtensionToWebview,
  safeParseWebviewToExtension,
} from '../../shared/messages';
import type * as vscode from 'vscode';

/**
 * Typed message bus between extension host and webview.
 * All payloads are validated with zod on send/receive.
 */
export class MessageBus {
  constructor(private readonly webview: vscode.Webview) {}

  post(message: ExtensionToWebview): void {
    const validated = parseExtensionToWebview(message);
    void this.webview.postMessage(validated);
  }

  onMessage(handler: (message: WebviewToExtension) => void): vscode.Disposable {
    return this.webview.onDidReceiveMessage((raw: unknown) => {
      const parsed = safeParseWebviewToExtension(raw);
      if (!parsed.success) {
        this.post({
          type: 'error',
          payload: {
            message: `Invalid webview message: ${parsed.error.message}`,
            scope: 'message-bus',
          },
        });
        return;
      }
      handler(parsed.data);
    });
  }
}
