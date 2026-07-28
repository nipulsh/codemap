import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  test('Open Architecture command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('codemap.openArchitecture'));
    assert.ok(commands.includes('codemap.refreshGraph'));
  });
});
