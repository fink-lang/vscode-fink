import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';

// Spawns `fink run --dbg <program>`, waits for the WebSocket URL,
// then starts a js-debug attach session via CDP.
//
// Flow: user launches type "fink" → resolver spawns fink, waits for
// ws:// ready line → cancels the fink session → starts a "node" attach
// session pointing at the WebSocket.

const output = vscode.window.createOutputChannel('Fink Debug');
let finkProcess: ChildProcess | undefined;

export class FinkDebugConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (!config.program) {
      vscode.window.showErrorMessage('No program specified in launch configuration.');
      return undefined;
    }

    finkProcess?.kill();

    const workspaceFolder = folder?.uri.fsPath || '';
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath || '';
    const resolveVars = (s: string) =>
      s
        .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
        .replace(/\$\{file\}/g, activeFile);

    const executable = resolveVars(config.runtimeExecutable || 'fink');
    const program = resolveVars(config.program);
    const dbgFlag = config.stopOnEntry ? '--dbg=brk' : '--dbg';
    const args = ['run', dbgFlag, program];

    output.appendLine(`Starting: ${executable} ${args.join(' ')}`);
    output.show(true);

    let wsUrl: string;
    try {
      wsUrl = await spawnFink(executable, args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Fink debug: ${msg}`);
      return undefined;
    }

    output.appendLine(`Attaching to ${wsUrl}`);

    // Start the node attach session after the resolver returns.
    // Cannot change type within resolveDebugConfiguration, so we
    // cancel this session and start a new one.
    setImmediate(() => {
      vscode.debug.startDebugging(folder, {
        type: 'node',
        request: 'attach',
        name: config.name || 'Fink Debug',
        websocketAddress: wsUrl,
        timeout: 30_000,
      });
    });

    return undefined;
  }

  dispose(): void {
    finkProcess?.kill();
    finkProcess = undefined;
  }
}

// Kill fink when the node attach session ends (not the cancelled fink session)
export function registerDebugLifecycle(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === 'node' && finkProcess) {
        output.appendLine('Debug session ended, stopping fink');
        finkProcess.kill();
        finkProcess = undefined;
      }
    })
  );
}

function spawnFink(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    finkProcess = child;
    let resolved = false;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for fink debugger to start'));
    }, 10_000);

    const onData = (data: Buffer) => {
      const text = data.toString();
      output.appendLine(text);

      if (!resolved) {
        const match = text.match(/ws:\/\/[\S]+/);
        if (match) {
          resolved = true;
          clearTimeout(timeout);
          resolve(match[0]);
        }
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) reject(new Error(`Failed to start fink: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      output.appendLine(`fink exited with code ${code}`);
      if (!resolved && code !== null && code !== 0) {
        reject(new Error(`fink exited with code ${code}`));
      }
    });
  });
}
