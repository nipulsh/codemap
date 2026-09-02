import * as vscode from 'vscode';
import { ArchitecturePanel } from './ArchitecturePanel';
import { registerArchitectureCommands } from './architectureCommands';

export function activate(context: vscode.ExtensionContext): void {
  registerArchitectureCommands(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.openArchitecture', () => {
      const panel = ArchitecturePanel.createOrShow(context.extensionUri);
      void panel.bootstrap();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.refreshGraph', () => {
      if (ArchitecturePanel.current) {
        void ArchitecturePanel.current.refresh();
      } else {
        const panel = ArchitecturePanel.createOrShow(context.extensionUri);
        void panel.bootstrap();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.openRouteTrace', () => {
      const panel = ArchitecturePanel.createOrShow(context.extensionUri);
      void panel.openRouteTrace();
    }),
  );
}

export function deactivate(): void {
  ArchitecturePanel.current?.dispose();
}
