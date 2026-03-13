import * as vscode from 'vscode';

// Token legend — indices must match the Rust constants in src/lib.rs
const tokenTypes = ['function', 'variable', 'property', 'block-name', 'tag-left', 'tag-right'];
const tokenModifiers = ['readonly'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// WASM module — initialized in activate()
let get_semantic_tokens: (src: string) => Uint32Array;
let get_diagnostics: (src: string) => string;
let debug = false;

async function loadWasm(context: vscode.ExtensionContext): Promise<void> {
  const wasmUri = vscode.Uri.joinPath(
    context.extensionUri, 'build', 'pkg', 'wasm', 'fink_wasm_bg.wasm'
  );
  const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);

  const jsUri = vscode.Uri.joinPath(
    context.extensionUri, 'build', 'pkg', 'wasm', 'fink_wasm.js'
  );
  const jsBytes = await vscode.workspace.fs.readFile(jsUri);
  const jsCode = new TextDecoder().decode(jsBytes);

  // Load the wasm-bindgen JS glue as a module via data URL (works in both desktop and web)
  const dataUrl = `data:text/javascript;base64,${btoa(jsCode)}`;
  const wasmModule = await import(dataUrl);
  await wasmModule.default(wasmBytes.buffer);
  get_semantic_tokens = wasmModule.get_semantic_tokens;
  get_diagnostics = wasmModule.get_diagnostics;
}

interface DiagnosticEntry {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  source: 'lexer' | 'parser';
}

const diagnosticCollection = vscode.languages.createDiagnosticCollection('fink');

function updateDiagnostics(document: vscode.TextDocument): void {
  const src = document.getText();
  if (debug) console.time('fink:diagnostics');
  const json = get_diagnostics(src);
  if (debug) console.timeEnd('fink:diagnostics');
  const entries: DiagnosticEntry[] = JSON.parse(json);

  const diagnostics = entries.map(e => {
    const range = new vscode.Range(e.line, e.col, e.endLine, e.endCol);
    const diag = new vscode.Diagnostic(range, e.message, vscode.DiagnosticSeverity.Error);
    diag.source = `fink (${e.source})`;
    return diag;
  });

  diagnosticCollection.set(document.uri, diagnostics);
}

const provider: vscode.DocumentSemanticTokensProvider = {
  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const src = document.getText();
    if (debug) console.time('fink:semanticTokens');
    const data = get_semantic_tokens(src);
    if (debug) console.timeEnd('fink:semanticTokens');
    return new vscode.SemanticTokens(data);
  }
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  debug = context.extensionMode === vscode.ExtensionMode.Development;
  await loadWasm(context);

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      'fink', provider, legend
    )
  );

  context.subscriptions.push(diagnosticCollection);

  // Update diagnostics on document change and open
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId === 'fink') {
        updateDiagnostics(e.document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'fink') {
        updateDiagnostics(doc);
      }
    })
  );

  // Clear diagnostics when document is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      diagnosticCollection.delete(doc.uri);
    })
  );

  // Update diagnostics for already-open fink documents
  vscode.workspace.textDocuments.forEach(doc => {
    if (doc.languageId === 'fink') {
      updateDiagnostics(doc);
    }
  });
}
