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
  // Line diff dominates so multi-line ranges sort after single-line ones.
  if (r.line === r.endLine) return r.endCol - r.col;
  return (r.endLine - r.line) * 100000 + (r.endCol - r.col);
}

// Offset comparison on (line, col). Returns <0 if a before b, 0 equal, >0 after.
function cmpPos(aLine: number, aCol: number, bLine: number, bCol: number): number {
  if (aLine !== bLine) return aLine - bLine;
  return aCol - bCol;
}

// True if `outer` fully covers `inner` (inner.start ≥ outer.start AND inner.end ≤ outer.end).
// Zero-width inner is allowed — a point at outer.start or outer.end is subsumed.
function rangeSubsumes(outer: SmRange, inner: SmRange): boolean {
  const startOk = cmpPos(inner.line, inner.col, outer.line, outer.col) >= 0;
  const endOk = cmpPos(inner.endLine, inner.endCol, outer.endLine, outer.endCol) <= 0;
  return startOk && endOk;
}

// Merge contiguous/overlapping ranges. Input need not be sorted.
// "Contiguous" means b.start ≤ a.end — zero-width ranges at a boundary count.
function mergeContiguous(ranges: SmRange[]): SmRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) =>
    cmpPos(a.line, a.col, b.line, b.col) || cmpPos(a.endLine, a.endCol, b.endLine, b.endCol)
  );
  const out: SmRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cmpPos(cur.line, cur.col, prev.endLine, prev.endCol) <= 0) {
      // Overlap or touch — extend prev's end if cur ends later.
      if (cmpPos(cur.endLine, cur.endCol, prev.endLine, prev.endCol) > 0) {
        out[out.length - 1] = {
          line: prev.line, col: prev.col,
          endLine: cur.endLine, endCol: cur.endCol
        };
      }
    } else {
      out.push(cur);
    }
  }
  return out;
}

interface HighlightRegions { out: SmRange; src?: SmRange; }

// fink emits one mapping per generated token; many generated tokens share the
// same source range (the whole source expression). Hovering in one block
// should light up the CORRESPONDING contiguous region in the other — not a
// single token from within, and not the outer wrapper mappings that happen to
// share the same src span.
//
// Strategy:
//   1. Find the smallest mapping-range (on either side) containing the cursor.
//   2. Classify every sibling mapping relative to that hit range (IN / NARROW /
//      OUT / GLUE / GLUE_BREAK) and form contiguous runs on the opposite side.
//   3. Pick the run whose members prove it's the inner-expression generation
//      (contains NARROW child mappings). Fall back to smallest run otherwise.
function findHighlightRegions(groups: SmGroup[], pos: vscode.Position): HighlightRegions | undefined {
  // Step 1: smallest positive-size mapping (on either side) containing pos.
  // Zero-width mappings are a last-resort fallback.
  let hitGroup: SmGroup | undefined;
  let hitRange: SmRange | undefined;
  let hitSide: 'src' | 'out' = 'out';
  let hitSize = Infinity;
  let fallbackGroup: SmGroup | undefined;
  let fallbackRange: SmRange | undefined;
  let fallbackSide: 'src' | 'out' = 'out';

  for (const group of groups) {
    for (const m of group.mappings) {
      if (rangeContains(m.out, pos)) {
        const sz = rangeSize(m.out);
        if (sz > 0 && sz < hitSize) {
          hitSize = sz; hitGroup = group; hitRange = m.out; hitSide = 'out';
        } else if (sz === 0 && !fallbackRange) {
          fallbackGroup = group; fallbackRange = m.out; fallbackSide = 'out';
        }
      }
      if (m.src && rangeContains(m.src, pos)) {
        const sz = rangeSize(m.src);
        if (sz > 0 && sz < hitSize) {
          hitSize = sz; hitGroup = group; hitRange = m.src; hitSide = 'src';
        } else if (sz === 0 && !fallbackRange) {
          fallbackGroup = group; fallbackRange = m.src; fallbackSide = 'src';
        }
      }
    }
  }

  if (!hitGroup || !hitRange) {
    if (!fallbackGroup || !fallbackRange) return undefined;
    hitGroup = fallbackGroup;
    hitRange = fallbackRange;
    hitSide = fallbackSide;
  }

  // Step 2: walk the group's mappings in order, classifying each.
  //   IN     — hit-side range is subsumed by hitRange (exact-match sibling)
  //   NARROW — IN AND strictly narrower than hitRange (distinguishes the
  //            inner-expression run from outer prologue/epilogue wrappers
  //            that share the same src span)
  //   OUT    — hit-side range present but NOT subsumed
  //   GLUE   — no hit-side range (separators like ", "). Joins adjacent
  //            IN mappings within a single line.
  //   GLUE_BREAK — a GLUE whose opposite-side span crosses a newline.
  //            Breaks runs so prologue and body don't merge across lines.
  type Kind = 'IN' | 'NARROW' | 'OUT' | 'GLUE' | 'GLUE_BREAK';
  const classify: Kind[] = [];
  for (const m of hitGroup.mappings) {
    const ownSide = hitSide === 'src' ? m.src : m.out;
    if (!ownSide) {
      const opp = hitSide === 'src' ? m.out : m.src;
      const breaks = opp ? opp.line !== opp.endLine : false;
      classify.push(breaks ? 'GLUE_BREAK' : 'GLUE');
    } else if (rangeSubsumes(hitRange, ownSide)) {
      const strictlyNarrower = rangeSize(ownSide) < rangeSize(hitRange);
      classify.push(strictlyNarrower ? 'NARROW' : 'IN');
    } else {
      classify.push('OUT');
    }
  }

  // Form runs of IN/NARROW mappings, absorbing same-line GLUE between them.
  // OUT or GLUE_BREAK close the current run.
  interface Run { ranges: SmRange[]; narrowCount: number; }
  const runs: Run[] = [];
  let current: Run = { ranges: [], narrowCount: 0 };
  let currentHasIn = false;
  let pendingGlue: SmRange[] = [];

  const flush = () => {
    if (currentHasIn) runs.push(current);
    current = { ranges: [], narrowCount: 0 };
    currentHasIn = false;
    pendingGlue = [];
  };

  for (let i = 0; i < hitGroup.mappings.length; i++) {
    const m = hitGroup.mappings[i];
    const kind = classify[i];
    const opp = hitSide === 'src' ? m.out : m.src;
    if (kind === 'IN' || kind === 'NARROW') {
      if (currentHasIn && pendingGlue.length > 0) current.ranges.push(...pendingGlue);
      pendingGlue = [];
      if (opp) current.ranges.push(opp);
      if (kind === 'NARROW') current.narrowCount++;
      currentHasIn = true;
    } else if (kind === 'GLUE') {
      if (currentHasIn && opp) pendingGlue.push(opp);
    } else {
      flush();
    }
  }
  flush();

  if (runs.length === 0) {
    return hitSide === 'src' ? { src: hitRange, out: hitRange } : { out: hitRange };
  }

  // Merge each run's ranges into a single span. A run may have zero ranges if
  // all its IN mappings lacked an opposite-side range — drop those.
  const merged: Array<{ range: SmRange; narrowCount: number }> = [];
  for (const r of runs) {
    const m = mergeContiguous(r.ranges);
    if (m.length === 0) continue;
    const range = m.length === 1
      ? m[0]
      : { line: m[0].line, col: m[0].col, endLine: m[m.length - 1].endLine, endCol: m[m.length - 1].endCol };
    merged.push({ range, narrowCount: r.narrowCount });
  }
  if (merged.length === 0) {
    return hitSide === 'src' ? { src: hitRange, out: hitRange } : { out: hitRange };
  }

  // Prefer runs with NARROW child mappings (they mark the inner-expression
  // generation) over runs that only contain same-src wrappers. If no run has
  // NARROW, all runs are equivalent — fall back to smallest.
  const maxNarrow = merged.reduce((a, r) => Math.max(a, r.narrowCount), 0);
  const candidates = maxNarrow > 0
    ? merged.filter(r => r.narrowCount === maxNarrow).map(r => r.range)
    : merged.map(r => r.range);

  let best = candidates[0];
  let bestSize = rangeSize(best);
  for (let i = 1; i < candidates.length; i++) {
    const sz = rangeSize(candidates[i]);
    if (sz < bestSize) { best = candidates[i]; bestSize = sz; }
  }

  return hitSide === 'src' ? { src: hitRange, out: best } : { out: hitRange, src: best };
}

function applySmHighlight(editor: vscode.TextEditor, pos: vscode.Position): void {
  const groups = smCache.get(editor.document.uri.toString());
  if (!groups || groups.length === 0) {
    editor.setDecorations(smOutDecoration, []);
    editor.setDecorations(smSrcDecoration, []);
    return;
  }
  const r = findHighlightRegions(groups, pos);
  if (!r) {
    editor.setDecorations(smOutDecoration, []);
    editor.setDecorations(smSrcDecoration, []);
    return;
  }
  editor.setDecorations(smOutDecoration, [rangeFromSm(r.out)]);
  editor.setDecorations(smSrcDecoration, r.src ? [rangeFromSm(r.src)] : []);
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
