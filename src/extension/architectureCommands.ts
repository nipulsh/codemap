import * as vscode from 'vscode';
import { join } from 'node:path';
import { WorkspaceAnalysisService } from '../analysis/WorkspaceAnalysisService';
import type { WorkspaceAnalysisResult } from '../analysis/types';
import { analyzeArchitecture } from '../documentation/ArchitectureAnalyzer';
import { buildArchitectureDocument } from '../documentation/ArchitectureDocumentBuilder';
import { isAnalysisCancelledError } from '../utils/cancellation';

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

function getConfig(): {
  architectureFile: string;
  includeFunctionDetails: boolean;
  includeDependencyGraph: boolean;
  agentOptimized: boolean;
} {
  const config = vscode.workspace.getConfiguration('codemap');
  return {
    architectureFile:
      config.get<string>('architectureFile') ?? 'PROJECT_ARCHITECTURE.md',
    includeFunctionDetails:
      config.get<boolean>('documentation.includeFunctionDetails') ?? true,
    includeDependencyGraph:
      config.get<boolean>('documentation.includeDependencyGraph') ?? true,
    agentOptimized:
      config.get<boolean>('documentation.agentOptimized') ?? true,
  };
}

/**
 * Run the eager analysis with a cancellable progress notification.
 * The VS Code cancellation token is bridged to an AbortSignal; analyzeAsync()
 * yields to the event loop so the token callback can actually fire mid-run.
 */
async function analyzeWithProgress(
  workspaceRoot: string,
  title: string,
): Promise<WorkspaceAnalysisResult> {
  const service = new WorkspaceAnalysisService();
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() =>
        controller.abort(),
      );
      try {
        return await service.analyzeAsync(workspaceRoot, {
          signal: controller.signal,
          onProgress: (message, percent) => {
            progress.report({
              message,
              increment: percent !== undefined ? percent / 10 : undefined,
            });
          },
        });
      } finally {
        subscription.dispose();
      }
    },
  );
}

function reportFailure(prefix: string, err: unknown): void {
  if (isAnalysisCancelledError(err)) {
    void vscode.window.showInformationMessage(`${prefix} — cancelled.`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`${prefix} — ${message}`);
}

async function runAnalysis(
  workspaceRoot: string,
): Promise<{ markdown: string; outputPath: string }> {
  const cfg = getConfig();
  const result = await analyzeWithProgress(
    workspaceRoot,
    'CodeMap: Analyzing workspace…',
  );

  if (result.files.length === 0) {
    throw new Error('No analyzable source files found in the workspace.');
  }

  const architecture = analyzeArchitecture(result);
  const doc = buildArchitectureDocument(architecture, {
    includeFunctionDetails: cfg.includeFunctionDetails,
    includeDependencyGraph: cfg.includeDependencyGraph,
    agentOptimized: cfg.agentOptimized,
  });

  const outputPath = join(workspaceRoot, cfg.architectureFile);
  return { markdown: doc.fullMarkdown, outputPath };
}

async function writeAndOpenDocument(
  markdown: string,
  outputPath: string,
): Promise<void> {
  const uri = vscode.Uri.file(outputPath);
  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(uri, encoder.encode(markdown));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function registerArchitectureCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codemap.generateArchitectureDocument',
      async () => {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            'CodeMap: Open a workspace folder first.',
          );
          return;
        }

        try {
          const { markdown, outputPath } = await runAnalysis(workspaceRoot);
          await writeAndOpenDocument(markdown, outputPath);
          void vscode.window.showInformationMessage(
            `CodeMap: Architecture document written to ${outputPath}`,
          );
        } catch (err) {
          reportFailure(
            'CodeMap: Failed to generate architecture document',
            err,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codemap.updateArchitectureDocument',
      async () => {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            'CodeMap: Open a workspace folder first.',
          );
          return;
        }

        try {
          const { markdown, outputPath } = await runAnalysis(workspaceRoot);
          await writeAndOpenDocument(markdown, outputPath);
          void vscode.window.showInformationMessage(
            `CodeMap: Architecture document updated at ${outputPath}`,
          );
        } catch (err) {
          reportFailure('CodeMap: Failed to update architecture document', err);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.copyAgentContext', async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage(
          'CodeMap: Open a workspace folder first.',
        );
        return;
      }

      try {
        const cfg = getConfig();
        const result = await analyzeWithProgress(
          workspaceRoot,
          'CodeMap: Building agent context…',
        );

        const architecture = analyzeArchitecture(result);
        const doc = buildArchitectureDocument(architecture, {
          includeFunctionDetails: cfg.includeFunctionDetails,
          includeDependencyGraph: cfg.includeDependencyGraph,
          agentOptimized: cfg.agentOptimized,
        });

        await vscode.env.clipboard.writeText(doc.agentContext);
        void vscode.window.showInformationMessage(
          'CodeMap: Agent context copied to clipboard.',
        );
      } catch (err) {
        reportFailure('CodeMap: Failed to copy agent context', err);
      }
    }),
  );
}
