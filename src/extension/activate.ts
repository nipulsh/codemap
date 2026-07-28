import * as vscode from 'vscode';
import { ArchitecturePanel } from './ArchitecturePanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.openArchitecture', () => {
      const panel = ArchitecturePanel.createOrShow(context.extensionUri);
      void panel.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.refreshGraph', () => {
      if (ArchitecturePanel.current) {
        void ArchitecturePanel.current.refresh();
      } else {
        const panel = ArchitecturePanel.createOrShow(context.extensionUri);
        void panel.refresh();
      }
    }),
  );
}

export function deactivate(): void {
  ArchitecturePanel.current?.dispose();
}
