import * as vscode from 'vscode';

// Token legend — indices must match the Rust constants in src/lib.rs
const tokenTypes = ['function', 'variable', 'property', 'block-name', 'tag-left', 'tag-right'];
const tokenModifiers = ['readonly'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// WASM module — initialized in activate()
let get_semantic_tokens: (src: string) => Uint32Array;
let get_diagnostics: (src: string) => string;
let get_definition: (src: string, line: number, col: number) => Uint32Array;
let get_references: (src: string, line: number, col: number) => Uint32Array;
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
  get_definition = wasmModule.get_definition;
  get_references = wasmModule.get_references;
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

// Definition provider: calls get_definition(src, line, col) which returns
// [def_line, def_col, def_end_line, def_end_col] or empty if no definition found.
const definitionProvider: vscode.DefinitionProvider = {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    if (!get_definition) return undefined;

    const src = document.getText();
    if (debug) console.time('fink:definition');
    const data = get_definition(src, position.line, position.character);
    if (debug) console.timeEnd('fink:definition');

    if (data.length === 4) {
      const defRange = new vscode.Range(data[0], data[1], data[2], data[3]);
      return new vscode.Location(document.uri, defRange);
    }

    return undefined;
  }
};

// Reference provider: calls get_references(src, line, col) which returns
// [line, col, end_line, end_col, ...] (4 u32s per location) or empty.
const referenceProvider: vscode.ReferenceProvider = {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Location[] | undefined {
    if (!get_references) return undefined;

    const src = document.getText();
    if (debug) console.time('fink:references');
    const data = get_references(src, position.line, position.character);
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
    if (!get_references) return undefined;

    const src = document.getText();
    const data = get_references(src, position.line, position.character);
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
    if (!get_references) return undefined;

    const src = document.getText();
    const data = get_references(src, position.line, position.character);
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
    if (!get_references) return undefined;

    const src = document.getText();
    const data = get_references(src, position.line, position.character);
    if (data.length === 0) return undefined;

    const edit = new vscode.WorkspaceEdit();
    for (let i = 0; i < data.length; i += 4) {
      const range = new vscode.Range(data[i], data[i + 1], data[i + 2], data[i + 3]);
      edit.replace(document.uri, range, newName);
    }
    return edit;
  }
};

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
