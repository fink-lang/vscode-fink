import * as vscode from 'vscode';
import { FinkDapAdapterFactory, FinkDapConfigurationProvider } from './dap-adapter-factory';

// Token legend — indices must match the Rust constants in src/lib.rs
const tokenTypes = ['function', 'variable', 'property', 'block-name', 'tag-left', 'tag-right'];
const tokenModifiers = ['readonly'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// WASM module — initialized in activate()
let ParsedDocument: {
  new(src: string): ParsedDocumentHandle;
} | undefined;
let debug = false;
let statusBarItem: vscode.StatusBarItem;

// Opaque handle to a Rust ParsedDocument struct living in WASM memory.
// Must be .free()'d explicitly; FinalizationRegistry acts as safety net.
interface ParsedDocumentHandle {
  get_semantic_tokens(): Uint32Array;
  get_diagnostics(): string;
  get_definition(line: number, col: number): Uint32Array;
  get_references(line: number, col: number): Uint32Array;
  free(): void;
}

// Active document handles, keyed by URI string.
// Each edit replaces the old handle (freed explicitly).
const docs = new Map<string, ParsedDocumentHandle>();

function getDoc(document: vscode.TextDocument): ParsedDocumentHandle | undefined {
  return docs.get(document.uri.toString());
}

function updateDoc(document: vscode.TextDocument): void {
  if (!ParsedDocument) return;
  const key = document.uri.toString();
  docs.get(key)?.free();
  const t0 = performance.now();
  const doc = new ParsedDocument(document.getText());
  const parseMs = performance.now() - t0;
  docs.set(key, doc);
  statusBarItem.text = `$(check) ƒink ${parseMs.toFixed(1)}ms`;

  // Update diagnostics from the freshly parsed document
  const json = doc.get_diagnostics();
  const entries: DiagnosticEntry[] = JSON.parse(json);
  const diagnostics = entries.map(e => {
    const range = new vscode.Range(e.line, e.col, e.endLine, e.endCol);
    const severity = e.severity === 'warning'
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Error;
    const diag = new vscode.Diagnostic(range, e.message, severity);
    diag.source = `fink (${e.source})`;
    return diag;
  });
  diagnosticCollection.set(document.uri, diagnostics);
  semanticTokensChangeEmitter.fire();
}

async function loadWasm(context: vscode.ExtensionContext): Promise<void> {
  const wasmUri = vscode.Uri.joinPath(
    context.extensionUri, 'build', 'pkg', 'wasm', 'fink_wasm_bg.wasm'
  );
  const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);

  const jsUri = vscode.Uri.joinPath(
    context.extensionUri, 'build', 'pkg', 'wasm', 'fink_wasm.js'
  );
  const jsBytes = await vscode.workspace.fs.readFile(jsUri);

  // Load the wasm-bindgen JS glue as a module via data URL (works in both desktop and web).
  // Use Uint8Array → binary string → btoa to handle non-Latin-1 chars in the JS source.
  const binaryStr = Array.from(jsBytes, (b: number) => String.fromCharCode(b)).join('');
  const dataUrl = `data:text/javascript;base64,${btoa(binaryStr)}`;
  const wasmModule = await import(dataUrl);
  await wasmModule.default(wasmBytes.buffer);
  ParsedDocument = wasmModule.ParsedDocument;
}

function setStatus(ok: boolean): void {
  statusBarItem.text = ok ? '$(check) ƒink' : '$(warning) ƒink';
  statusBarItem.tooltip = ok ? 'ƒink WASM loaded — click to reload' : 'ƒink WASM not loaded — click to reload';
}

async function reloadWasm(context: vscode.ExtensionContext): Promise<void> {
  // Free all existing handles
  for (const handle of docs.values()) {
    handle.free();
  }
  docs.clear();
  diagnosticCollection.clear();

  try {
    await loadWasm(context);
    setStatus(true);
  } catch (err) {
    ParsedDocument = undefined;
    setStatus(false);
    console.warn('fink: WASM reload failed:', err);
    vscode.window.showWarningMessage(`fink: WASM reload failed: ${err}`);
    return;
  }

  // Re-parse all open fink documents
  vscode.workspace.textDocuments.forEach(doc => {
    if (doc.languageId === 'fink') {
      updateDoc(doc);
    }
  });
}

interface DiagnosticEntry {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  source: 'lexer' | 'parser' | 'name_res';
  severity: 'error' | 'warning';
}

const diagnosticCollection = vscode.languages.createDiagnosticCollection('fink');
const semanticTokensChangeEmitter = new vscode.EventEmitter<void>();

// Definition provider: queries cached ParsedDocument handle.
const definitionProvider: vscode.DefinitionProvider = {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const doc = getDoc(document);
    if (!doc) return undefined;

    if (debug) console.time('fink:definition');
    const data = doc.get_definition(position.line, position.character);
    if (debug) console.timeEnd('fink:definition');

    if (data.length === 4) {
      const defRange = new vscode.Range(data[0], data[1], data[2], data[3]);
      return new vscode.Location(document.uri, defRange);
    }

    return undefined;
  }
};

// Reference provider: queries cached ParsedDocument handle.
const referenceProvider: vscode.ReferenceProvider = {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Location[] | undefined {
    const doc = getDoc(document);
    if (!doc) return undefined;

    if (debug) console.time('fink:references');
    const data = doc.get_references(position.line, position.character);
    if (debug) console.timeEnd('fink:references');

    if (data.length === 0) return undefined;

    const locations: vscode.Location[] = [];
    for (let i = 0; i < data.length; i += 4) {
      const range = new vscode.Range(data[i], data[i + 1], data[i + 2], data[i + 3]);
      locations.push(new vscode.Location(document.uri, range));
    }
    return locations;
  }
};

// Document highlight provider: highlights all occurrences of the symbol under cursor.
// The first entry from get_references is the binding site (Write), rest are reads.
const documentHighlightProvider: vscode.DocumentHighlightProvider = {
  provideDocumentHighlights(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.DocumentHighlight[] | undefined {
    const doc = getDoc(document);
    if (!doc) return undefined;

    const data = doc.get_references(position.line, position.character);
    if (data.length === 0) return undefined;

    const highlights: vscode.DocumentHighlight[] = [];
    for (let i = 0; i < data.length; i += 4) {
      const range = new vscode.Range(data[i], data[i + 1], data[i + 2], data[i + 3]);
      const kind = i === 0
        ? vscode.DocumentHighlightKind.Write
        : vscode.DocumentHighlightKind.Read;
      highlights.push(new vscode.DocumentHighlight(range, kind));
    }
    return highlights;
  }
};

// Rename provider: reuses get_references to find all locations, then replaces each.
const renameProvider: vscode.RenameProvider = {
  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Range | undefined {
    const doc = getDoc(document);
    if (!doc) return undefined;

    const data = doc.get_references(position.line, position.character);
    if (data.length === 0) return undefined;

    // Find the reference range that contains the cursor position
    for (let i = 0; i < data.length; i += 4) {
      const range = new vscode.Range(data[i], data[i + 1], data[i + 2], data[i + 3]);
      if (range.contains(position)) {
        return range;
      }
    }
    return undefined;
  },

  provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): vscode.WorkspaceEdit | undefined {
    const doc = getDoc(document);
    if (!doc) return undefined;

    const data = doc.get_references(position.line, position.character);
    if (data.length === 0) return undefined;

    const edit = new vscode.WorkspaceEdit();
    for (let i = 0; i < data.length; i += 4) {
      const range = new vscode.Range(data[i], data[i + 1], data[i + 2], data[i + 3]);
      edit.replace(document.uri, range, newName);
    }
    return edit;
  }
};

// Semantic tokens provider: returns cached tokens from ParsedDocument.
// onDidChangeSemanticTokens tells VS Code to re-request tokens after each parse.
const provider: vscode.DocumentSemanticTokensProvider = {
  onDidChangeSemanticTokens: semanticTokensChangeEmitter.event,
  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const doc = getDoc(document);
    if (!doc) return new vscode.SemanticTokens(new Uint32Array(0));

    if (debug) console.time('fink:semanticTokens');
    const data = doc.get_semantic_tokens();
    if (debug) console.timeEnd('fink:semanticTokens');
    return new vscode.SemanticTokens(data);
  }
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  debug = context.extensionMode === vscode.ExtensionMode.Development;

  // Status bar item — click to reload WASM
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = 'fink.reloadWasm';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand('fink.reloadWasm', () => reloadWasm(context))
  );

  // Register native DAP adapter — spawns `fink dap <file>` on stdin/stdout
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('fink', new FinkDapConfigurationProvider())
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('fink', new FinkDapAdapterFactory())
  );

  try {
    await loadWasm(context);
    setStatus(true);
  } catch (err) {
    console.warn('fink: WASM load failed, language features disabled:', err);
    setStatus(false);
    return;
  }

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      'fink', provider, legend
    )
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('fink', definitionProvider)
  );

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider('fink', referenceProvider)
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentHighlightProvider('fink', documentHighlightProvider)
  );

  context.subscriptions.push(
    vscode.languages.registerRenameProvider('fink', renameProvider)
  );

  context.subscriptions.push(diagnosticCollection);
  context.subscriptions.push(semanticTokensChangeEmitter);

  // Parse on document change — single parse feeds all providers
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId === 'fink') {
        updateDoc(e.document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'fink') {
        updateDoc(doc);
      }
    })
  );

  // Free handle and clear diagnostics when document is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      const key = doc.uri.toString();
      docs.get(key)?.free();
      docs.delete(key);
      diagnosticCollection.delete(doc.uri);
    })
  );

  // Parse already-open fink documents
  vscode.workspace.textDocuments.forEach(doc => {
    if (doc.languageId === 'fink') {
      updateDoc(doc);
    }
  });
}
