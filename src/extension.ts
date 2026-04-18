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
let getSmMappings: ((src: string) => string) | undefined;
let debug = false;
let statusBarItem: vscode.StatusBarItem;

// Opaque handle to a Rust ParsedDocument struct living in WASM memory.
// Must be .free()'d explicitly; FinalizationRegistry acts as safety net.
interface ParsedDocumentHandle {
  get_semantic_tokens(): Uint32Array;
  get_diagnostics(): string;
  get_definition(line: number, col: number): Uint32Array;
  get_references(line: number, col: number): Uint32Array;
  get_imports(): string;
  get_module_binding(name: string): Uint32Array;
  free(): void;
}

interface ImportEntry {
  url: string;
  urlLine: number;
  urlCol: number;
  urlEndLine: number;
  urlEndCol: number;
  names: Array<{ name: string; line: number; col: number; endLine: number; endCol: number }>;
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

  updateSmMappings(document);
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
  getSmMappings = wasmModule.get_sm_mappings;
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

// Resolve a relative import URL to a file URI, parse it, and find the binding.
async function resolveImportDefinition(
  sourceUri: vscode.Uri,
  relativeUrl: string,
  name: string
): Promise<vscode.Location | undefined> {
  if (!ParsedDocument) return undefined;

  const sourceDir = vscode.Uri.joinPath(sourceUri, '..');
  const targetUri = vscode.Uri.joinPath(sourceDir, relativeUrl);

  try {
    const bytes = await vscode.workspace.fs.readFile(targetUri);
    const src = new TextDecoder().decode(bytes);
    const targetDoc = new ParsedDocument(src);
    try {
      const binding = targetDoc.get_module_binding(name);
      if (binding.length === 4) {
        const range = new vscode.Range(binding[0], binding[1], binding[2], binding[3]);
        return new vscode.Location(targetUri, range);
      }
    } finally {
      targetDoc.free();
    }
  } catch {
    // Target file not found or parse error — silently fall back
  }
  return undefined;
}

// Find which import name (if any) is at the given position.
function findImportAt(doc: ParsedDocumentHandle, line: number, col: number): { url: string; name: string } | undefined {
  const imports: ImportEntry[] = JSON.parse(doc.get_imports());
  for (const imp of imports) {
    for (const n of imp.names) {
      if (n.line === line && n.col <= col && col < n.endCol) {
        return { url: imp.url, name: n.name };
      }
    }
  }
  return undefined;
}

// Check if the cursor is on an import URL string, return the resolved file URI if so.
function findImportUrlAt(doc: ParsedDocumentHandle, documentUri: vscode.Uri, line: number, col: number): vscode.Uri | undefined {
  const imports: ImportEntry[] = JSON.parse(doc.get_imports());
  for (const imp of imports) {
    if (imp.urlLine === line && imp.urlCol <= col && col < imp.urlEndCol) {
      if (imp.url.startsWith('./') || imp.url.startsWith('../')) {
        const sourceDir = vscode.Uri.joinPath(documentUri, '..');
        return vscode.Uri.joinPath(sourceDir, imp.url);
      }
    }
  }
  return undefined;
}

// Check if a binding site is an import binding, and if so resolve into the target module.
async function tryResolveImport(
  doc: ParsedDocumentHandle,
  documentUri: vscode.Uri,
  bindLine: number,
  bindCol: number
): Promise<vscode.Location | undefined> {
  const imp = findImportAt(doc, bindLine, bindCol);
  if (imp && (imp.url.startsWith('./') || imp.url.startsWith('../'))) {
    return resolveImportDefinition(documentUri, imp.url, imp.name);
  }
  return undefined;
}

// Definition provider: follows imports to the target module.
// For imported names, F12 jumps to where the name is defined in the target file.
// For local names, F12 jumps to the local binding site.
const definitionProvider: vscode.DefinitionProvider = {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Definition | undefined> {
    const doc = getDoc(document);
    if (!doc) return undefined;

    // Cmd+click on import URL string → open the file
    const importFileUri = findImportUrlAt(doc, document.uri, position.line, position.character);
    if (importFileUri) {
      return new vscode.Location(importFileUri, new vscode.Position(0, 0));
    }

    if (debug) console.time('fink:definition');
    const data = doc.get_definition(position.line, position.character);
    if (debug) console.timeEnd('fink:definition');

    if (data.length !== 4) return undefined;

    const defRange = new vscode.Range(data[0], data[1], data[2], data[3]);

    // Try to follow import: check if the binding site is an import destructure
    const targetLocation = await tryResolveImport(doc, document.uri, defRange.start.line, defRange.start.character);
    if (targetLocation) return targetLocation;

    return new vscode.Location(document.uri, defRange);
  }
};

// Declaration provider: always returns the local binding site.
// For imported names, this is {foo} = import './spam.fnk'.
const declarationProvider: vscode.DeclarationProvider = {
  provideDeclaration(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Declaration | undefined {
    const doc = getDoc(document);
    if (!doc) return undefined;

    const data = doc.get_definition(position.line, position.character);
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

// --- Source-map highlighting for fink compiler test files ---

interface SmRange {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}
interface SmMapping {
  out: SmRange;
  src?: SmRange;
}
interface SmGroup {
  mappings: SmMapping[];
}

const smCache = new Map<string, SmGroup[]>();

function updateSmMappings(document: vscode.TextDocument): void {
  if (!getSmMappings) return;
  const key = document.uri.toString();
  try {
    const json = getSmMappings(document.getText());
    smCache.set(key, JSON.parse(json));
  } catch {
    smCache.delete(key);
  }
}

const smOutDecoration = vscode.window.createTextEditorDecorationType({
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: new vscode.ThemeColor('editorWarning.foreground'),
  borderRadius: '2px'
});
const smSrcDecoration = vscode.window.createTextEditorDecorationType({
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: new vscode.ThemeColor('editorInfo.foreground'),
  borderRadius: '2px'
});

function rangeFromSm(r: SmRange): vscode.Range {
  return new vscode.Range(r.line, r.col, r.endLine, r.endCol);
}

function rangeContains(r: SmRange, pos: vscode.Position): boolean {
  const afterStart = pos.line > r.line || (pos.line === r.line && pos.character >= r.col);
  const beforeEnd = pos.line < r.endLine || (pos.line === r.endLine && pos.character < r.endCol);
  return afterStart && beforeEnd;
}

function rangeSize(r: SmRange): number {
  // Used only for smallest-span tie-breaking. Line diff dominates when ranges
  // span multiple lines; otherwise char diff.
  if (r.line === r.endLine) return r.endCol - r.col;
  return (r.endLine - r.line) * 100000 + (r.endCol - r.col);
}

function findSmallestMappingAt(groups: SmGroup[], pos: vscode.Position): SmMapping | undefined {
  // Prefer the smallest POSITIVE-size span. Zero-width spans (two mappings
  // share the same output offset) only fire if there's no positive match.
  let best: SmMapping | undefined;
  let bestSize = Infinity;
  let bestFallback: SmMapping | undefined;
  for (const group of groups) {
    for (const m of group.mappings) {
      const inOut = rangeContains(m.out, pos);
      const inSrc = m.src ? rangeContains(m.src, pos) : false;
      if (!inOut && !inSrc) continue;
      const sizeOut = inOut ? rangeSize(m.out) : Infinity;
      const sizeSrc = inSrc && m.src ? rangeSize(m.src) : Infinity;
      const size = Math.min(sizeOut, sizeSrc);
      if (size > 0 && size < bestSize) {
        bestSize = size;
        best = m;
      } else if (size === 0 && !bestFallback) {
        bestFallback = m;
      }
    }
  }
  return best ?? bestFallback;
}

function applySmHighlight(editor: vscode.TextEditor, pos: vscode.Position): void {
  const groups = smCache.get(editor.document.uri.toString());
  if (!groups || groups.length === 0) {
    editor.setDecorations(smOutDecoration, []);
    editor.setDecorations(smSrcDecoration, []);
    return;
  }
  const m = findSmallestMappingAt(groups, pos);
  if (!m) {
    editor.setDecorations(smOutDecoration, []);
    editor.setDecorations(smSrcDecoration, []);
    return;
  }
  editor.setDecorations(smOutDecoration, [rangeFromSm(m.out)]);
  editor.setDecorations(smSrcDecoration, m.src ? [rangeFromSm(m.src)] : []);
}

function clearSmHighlight(editor: vscode.TextEditor): void {
  editor.setDecorations(smOutDecoration, []);
  editor.setDecorations(smSrcDecoration, []);
}

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
    vscode.languages.registerDeclarationProvider('fink', declarationProvider)
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
      smCache.delete(key);
    })
  );

  // Free sm decorations on shutdown.
  context.subscriptions.push(smOutDecoration, smSrcDecoration);

  // Drive sm highlighting from cursor moves in fink editors.
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor.document.languageId !== 'fink') return;
      applySmHighlight(e.textEditor, e.selections[0].active);
    })
  );

  // Also respond to hover — register a hover provider that, as a side effect,
  // paints the decoration. Return undefined so we don't actually show a hover
  // tooltip (decoration is the UI).
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('fink', {
      provideHover(document, position) {
        const editor = vscode.window.visibleTextEditors.find(
          e => e.document.uri.toString() === document.uri.toString()
        );
        if (editor) applySmHighlight(editor, position);
        return undefined;
      }
    })
  );

  // Clear decorations when switching editors.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) clearSmHighlight(editor);
    })
  );

  // Parse already-open fink documents
  vscode.workspace.textDocuments.forEach(doc => {
    if (doc.languageId === 'fink') {
      updateDoc(doc);
    }
  });
}
