import * as vscode from 'vscode';

// Resolves fink debug configurations by delegating to VSCode's built-in
// Node debugger with `runtimeExecutable: "fink"`.  VSCode handles process
// spawning, CDP attach, and lifecycle — we just assemble the right args.
// See .claude.local/notes/2026-03-19-1610-debug-brief.md for the design brief.

export class FinkDebugConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): vscode.DebugConfiguration | undefined {
    if (!config.program) {
      vscode.window.showErrorMessage('No program specified in launch configuration.');
      return undefined;
    }

    const dbgFlag = config.stopOnEntry ? '--dbg=brk' : '--dbg';

    return {
      ...config,
      type: 'node',
      request: 'launch',
      runtimeExecutable: vscode.workspace.getConfiguration('fink').get<string>('path', 'fink'),
      runtimeArgs: ['run', dbgFlag],
      program: config.program,
      port: 9229,
    };
  }
}
