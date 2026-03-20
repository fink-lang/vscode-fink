import * as vscode from 'vscode';

// DAP adapter factory for the native `fink dap` server.
// Spawns `fink dap <program>` as a child process; VSCode talks DAP
// on stdin/stdout directly — no CDP, no WebSocket.

export class FinkDapAdapterFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  createDebugAdapterDescriptor(
    session: vscode.DebugSession
  ): vscode.DebugAdapterDescriptor {
    const config = session.configuration;
    const finkPath = config.runtimeExecutable || 'fink';
    return new vscode.DebugAdapterExecutable(finkPath, ['dap', config.program]);
  }
}

// Minimal config provider — fills in defaults, validates required fields.
export class FinkDapConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): vscode.DebugConfiguration | undefined {
    if (!config.program) {
      vscode.window.showErrorMessage('No program specified in launch configuration.');
      return undefined;
    }

    // Resolve VSCode variables that aren't auto-resolved at this stage
    const workspaceFolder = folder?.uri.fsPath || '';
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath || '';
    const resolveVars = (s: string) =>
      s
        .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
        .replace(/\$\{file\}/g, activeFile);

    config.program = resolveVars(config.program);
    if (config.runtimeExecutable) {
      config.runtimeExecutable = resolveVars(config.runtimeExecutable);
    }

    return config;
  }
}
