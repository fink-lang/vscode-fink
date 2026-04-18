use std::collections::HashSet;
use wasm_bindgen::prelude::*;

use fink::ast::{Ast, AstId, Node, NodeKind};
use fink::lexer::{self, TokenKind};
use fink::passes;
use fink::passes::scopes::{self, BindId, BindOrigin, RefKind, ScopeEvent, ScopeKind};
use fink::sourcemap::native::SourceMap;

// Token type indices (must match TypeScript legend)
const TOKEN_FUNCTION: u32 = 0;
const TOKEN_VARIABLE: u32 = 1;
const TOKEN_PROPERTY: u32 = 2;
const TOKEN_BLOCK_NAME: u32 = 3;
const TOKEN_TAG_LEFT: u32 = 4;
const TOKEN_TAG_RIGHT: u32 = 5;

// Token modifier bits
const MOD_READONLY: u32 = 1; // bit 0

struct RawToken {
    line: u32,   // 0-based
    col: u32,    // 0-based
    length: u32,
    token_type: u32,
    modifiers: u32,
}

/// Resolve the callee of a function application.
/// Follows Member.rhs chain to find the actual callee node.
fn resolve_callee<'a>(ast: &'a Ast<'a>, id: AstId) -> &'a Node<'a> {
    let node = ast.nodes.get(id);
    match &node.kind {
        NodeKind::Member { rhs, .. } => resolve_callee(ast, *rhs),
        _ => node,
    }
}

fn emit_token(tokens: &mut Vec<RawToken>, node: &Node, token_type: u32, modifiers: u32) {
    let loc = &node.loc;
    // Rust parser uses 1-based lines, VSCode uses 0-based
    let line = loc.start.line.saturating_sub(1);
    let col = loc.start.col;
    let length = if loc.start.line == loc.end.line {
        loc.end.col - loc.start.col
    } else {
        // For multi-line tokens, just use the first line extent.
        // Identifiers are always single-line so this is a safety fallback.
        1
    };
    tokens.push(RawToken { line, col, length, token_type, modifiers });
}


fn collect_tokens<'src>(ast: &'src Ast<'src>, id: AstId, tokens: &mut Vec<RawToken>) {
    let node = ast.nodes.get(id);
    match &node.kind {
        NodeKind::Apply { func, args } => {
            let callee = resolve_callee(ast, *func);
            match &callee.kind {
                NodeKind::Ident(_) => {
                    // Tagged literal: callee adjacent to first arg
                    // Prefix: foo'bar' (callee end == arg start) → tag.left
                    // Postfix: 123foo (arg end == callee start) → tag.right
                    let tag_kind = args.items.first().and_then(|first_arg_id| {
                        let first_arg = ast.nodes.get(*first_arg_id);
                        if callee.loc.end.idx == first_arg.loc.start.idx {
                            Some(TOKEN_TAG_LEFT)
                        } else if first_arg.loc.end.idx == callee.loc.start.idx {
                            Some(TOKEN_TAG_RIGHT)
                        } else {
                            None
                        }
                    });
                    if let Some(tag_token) = tag_kind {
                        emit_token(tokens, callee, tag_token, 0);
                    } else {
                        emit_token(tokens, callee, TOKEN_FUNCTION, 0);
                    }
                }
                NodeKind::Group { .. } => {
                    // Emit function token at open and close paren positions
                    let loc = &callee.loc;
                    let open_line = loc.start.line.saturating_sub(1);
                    let close_line = loc.end.line.saturating_sub(1);
                    tokens.push(RawToken {
                        line: open_line,
                        col: loc.start.col,
                        length: 1,
                        token_type: TOKEN_FUNCTION,
                        modifiers: 0,
                    });
                    tokens.push(RawToken {
                        line: close_line,
                        col: loc.end.col.saturating_sub(1),
                        length: 1,
                        token_type: TOKEN_FUNCTION,
                        modifiers: 0,
                    });
                }
                _ => {}
            }
            // Recurse into func and args
            collect_tokens(ast, *func, tokens);
            for arg_id in args.items.iter() {
                collect_tokens(ast, *arg_id, tokens);
            }
        }

        NodeKind::Pipe(children) => {
            for child_id in children.items.iter() {
                let child = ast.nodes.get(*child_id);
                if matches!(&child.kind, NodeKind::Ident(_)) {
                    emit_token(tokens, child, TOKEN_FUNCTION, 0);
                }
                collect_tokens(ast, *child_id, tokens);
            }
        }

        NodeKind::LitRec { items: children, .. } => {
            for child_id in children.items.iter() {
                let child = ast.nodes.get(*child_id);
                if let NodeKind::Arm { lhs, body, .. } = &child.kind {
                    let lhs_node = ast.nodes.get(*lhs);
                    if let NodeKind::Patterns(pats) = &lhs_node.kind {
                        if let Some(first_lhs_id) = pats.items.first() {
                            let first_lhs = ast.nodes.get(*first_lhs_id);
                            if matches!(&first_lhs.kind, NodeKind::Ident(_)) {
                                if body.items.is_empty() {
                                    emit_token(tokens, first_lhs, TOKEN_VARIABLE, MOD_READONLY);
                                } else {
                                    emit_token(tokens, first_lhs, TOKEN_PROPERTY, 0);
                                }
                            }
                        }
                    }
                    // Recurse into arm body
                    for expr_id in body.items.iter() {
                        collect_tokens(ast, *expr_id, tokens);
                    }
                } else {
                    collect_tokens(ast, *child_id, tokens);
                }
            }
        }

        // --- recurse into all other container nodes ---

        NodeKind::Module { exprs: children, .. }
        | NodeKind::LitSeq { items: children, .. }
        | NodeKind::Patterns(children) => {
            for child_id in children.items.iter() {
                collect_tokens(ast, *child_id, tokens);
            }
        }

        NodeKind::StrTempl { children, .. }
        | NodeKind::StrRawTempl { children, .. } => {
            for child_id in children.iter() {
                collect_tokens(ast, *child_id, tokens);
            }
        }

        NodeKind::InfixOp { lhs, rhs, .. } => {
            collect_tokens(ast, *lhs, tokens);
            collect_tokens(ast, *rhs, tokens);
        }

        NodeKind::Bind { lhs, rhs, .. }
        | NodeKind::BindRight { lhs, rhs, .. }
        | NodeKind::Member { lhs, rhs, .. } => {
            collect_tokens(ast, *lhs, tokens);
            collect_tokens(ast, *rhs, tokens);
        }

        NodeKind::UnaryOp { operand, .. } => {
            collect_tokens(ast, *operand, tokens);
        }

        NodeKind::Group { inner, .. }
        | NodeKind::Try(inner) => {
            collect_tokens(ast, *inner, tokens);
        }

        NodeKind::Spread { inner: Some(inner), .. } => {
            collect_tokens(ast, *inner, tokens);
        }

        NodeKind::Fn { params, body, .. } => {
            collect_tokens(ast, *params, tokens);
            for expr_id in body.items.iter() {
                collect_tokens(ast, *expr_id, tokens);
            }
        }

        NodeKind::Match { subjects, arms, .. } => {
            for subj_id in subjects.items.iter() {
                collect_tokens(ast, *subj_id, tokens);
            }
            for arm_id in arms.items.iter() {
                collect_tokens(ast, *arm_id, tokens);
            }
        }

        NodeKind::Arm { lhs, body, .. } => {
            // Arms not inside LitRec — just recurse
            collect_tokens(ast, *lhs, tokens);
            for expr_id in body.items.iter() {
                collect_tokens(ast, *expr_id, tokens);
            }
        }

        NodeKind::Block { name, params, body, .. } => {
            // Emit namespace token for the block name
            let name_node = ast.nodes.get(*name);
            if matches!(&name_node.kind, NodeKind::Ident(_)) {
                emit_token(tokens, name_node, TOKEN_BLOCK_NAME, 0);
            }
            collect_tokens(ast, *name, tokens);
            collect_tokens(ast, *params, tokens);
            for expr_id in body.items.iter() {
                collect_tokens(ast, *expr_id, tokens);
            }
        }

        NodeKind::ChainedCmp(parts) => {
            for part in parts.iter() {
                if let fink::ast::CmpPart::Operand(operand_id) = part {
                    collect_tokens(ast, *operand_id, tokens);
                }
            }
        }

        // Leaf nodes — no children to recurse into
        NodeKind::Ident(_)
        | NodeKind::SynthIdent(_)
        | NodeKind::Token(_)
        | NodeKind::LitBool(_)
        | NodeKind::LitInt(_)
        | NodeKind::LitFloat(_)
        | NodeKind::LitDecimal(_)
        | NodeKind::LitStr { .. }
        | NodeKind::Partial
        | NodeKind::Wildcard
        | NodeKind::Spread { inner: None, .. } => {}
    }
}

fn delta_encode(mut tokens: Vec<RawToken>) -> Vec<u32> {
    tokens.sort_by(|a, b| a.line.cmp(&b.line).then(a.col.cmp(&b.col)));

    let mut result = Vec::with_capacity(tokens.len() * 5);
    let mut prev_line: u32 = 0;
    let mut prev_col: u32 = 0;

    for token in &tokens {
        let delta_line = token.line - prev_line;
        let delta_col = if delta_line > 0 { token.col } else { token.col - prev_col };

        result.push(delta_line);
        result.push(delta_col);
        result.push(token.length);
        result.push(token.token_type);
        result.push(token.modifiers);

        prev_line = token.line;
        prev_col = token.col;
    }

    result
}

// --- Pre-computed location data for cursor lookups ---

/// 0-based source location, owned (no borrows).
#[derive(Clone, Copy)]
struct Loc {
    line: u32,
    col: u32,
    end_line: u32,
    end_col: u32,
}

fn ast_loc(node: &Node) -> Loc {
    Loc {
        line: node.loc.start.line.saturating_sub(1),
        col: node.loc.start.col,
        end_line: node.loc.end.line.saturating_sub(1),
        end_col: node.loc.end.col,
    }
}

/// An identifier node mapped to its binding, for cursor hit-testing.
/// Sorted by (line, col) for binary search.
struct IdentEntry {
    loc: Loc,
    name: String,
    /// The BindId this ident resolves to (if it's a reference),
    /// or the BindId it defines (if it's a binding site).
    bind_id: Option<BindId>,
    /// True if this ident is the binding site (not a reference).
    is_binding_site: bool,
}

/// An imported name with its location in the import destructure.
struct ImportedName {
    name: String,
    loc: Loc,
}

/// An import statement: URL + its location + list of imported names with their locations.
struct ImportInfo {
    url: String,
    url_loc: Loc,
    names: Vec<ImportedName>,
}

/// Extract import info from the raw parsed AST.
/// Looks for: Bind { lhs: LitRec { Arm { Patterns([Ident]) } }, rhs: Apply { Ident("import"), [LitStr] } }
fn extract_imports(ast: &Ast) -> Vec<ImportInfo> {
    let root = ast.nodes.get(ast.root);
    let NodeKind::Module { exprs, .. } = &root.kind else { return vec![] };

    let mut imports = Vec::new();
    for expr_id in exprs.items.iter() {
        let expr = ast.nodes.get(*expr_id);
        let NodeKind::Bind { lhs, rhs, .. } = &expr.kind else { continue };

        // Check rhs is Apply { func: Ident("import"), args: [LitStr { content }] }
        let rhs_node = ast.nodes.get(*rhs);
        let NodeKind::Apply { func, args } = &rhs_node.kind else { continue };
        let func_node = ast.nodes.get(*func);
        if !matches!(&func_node.kind, NodeKind::Ident("import")) { continue }
        let Some(first_arg_id) = args.items.first() else { continue };
        let arg_node = ast.nodes.get(*first_arg_id);
        let NodeKind::LitStr { content: url, .. } = &arg_node.kind else { continue };

        // Extract names from lhs: LitRec { items: [Ident("foo"), Ident("bar"), ...] }
        // Bare shorthand {foo} produces direct Ident children, not Arm nodes.
        let lhs_node = ast.nodes.get(*lhs);
        let NodeKind::LitRec { items, .. } = &lhs_node.kind else { continue };

        let mut names = Vec::new();
        for item_id in items.items.iter() {
            let item_node = ast.nodes.get(*item_id);
            if let NodeKind::Ident(name) = &item_node.kind {
                names.push(ImportedName {
                    name: name.to_string(),
                    loc: ast_loc(item_node),
                });
            }
        }

        if !names.is_empty() {
            imports.push(ImportInfo { url: url.clone(), url_loc: ast_loc(arg_node), names });
        }
    }
    imports
}

/// Stateful parsed document - parse once, query many times.
/// Stores only owned data: no borrows, no lifetimes.
#[wasm_bindgen]
pub struct ParsedDocument {
    /// Delta-encoded semantic tokens, ready to return to VS Code.
    semantic_tokens: Vec<u32>,

    /// JSON diagnostics string, ready to return to VS Code.
    diagnostics: String,

    /// For each BindId, the source location of the binding site.
    bind_locs: Vec<Option<Loc>>,

    /// For each BindId, all AstIds that reference it (for find-references).
    bind_refs: Vec<Vec<Loc>>,

    /// Identifier nodes sorted by position, for cursor hit-testing.
    idents: Vec<IdentEntry>,

    /// Import statements extracted from the raw AST.
    imports: Vec<ImportInfo>,
}

#[wasm_bindgen]
impl ParsedDocument {
    /// Parse source code and pre-compute all provider data.
    #[wasm_bindgen(constructor)]
    pub fn new(src: &str) -> ParsedDocument {
        // --- Lexer diagnostics ---
        let mut diag_entries: Vec<String> = Vec::new();
        let lexer = lexer::tokenize_with_seps(src, &[
            b"+", b"-", b"*", b"/", b"//", b"**", b"%", b"%%", b"/%",
            b"==", b"!=", b"<", b"<=", b">", b">=", b"><",
            b"&", b"^", b"~", b">>", b"<<", b">>>", b"<<<",
            b".", b"|", b"|=", b"=", b"..", b"...",
        ]);
        for tok in lexer {
            if tok.kind == TokenKind::Err {
                let line = tok.loc.start.line.saturating_sub(1);
                let col = tok.loc.start.col;
                let end_line = tok.loc.end.line.saturating_sub(1);
                let end_col = tok.loc.end.col;
                let msg = tok.src.replace('\\', "\\\\").replace('"', "\\\"");
                diag_entries.push(format!(
                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"lexer","severity":"error"}}"#
                ));
            }
        }

        // --- Parse + desugar (partial-apply + index + scopes) ---
        let empty_doc = |diag_entries: Vec<String>, semantic_tokens: Vec<u32>, imports: Vec<ImportInfo>| ParsedDocument {
            semantic_tokens,
            diagnostics: format!("[{}]", diag_entries.join(",")),
            bind_locs: vec![],
            bind_refs: vec![],
            idents: vec![],
            imports,
        };

        let parsed = match passes::parse(src, "") {
            Ok(r) => r,
            Err(e) => {
                let line = e.loc.start.line.saturating_sub(1);
                let col = e.loc.start.col;
                let end_line = e.loc.end.line.saturating_sub(1);
                let end_col = e.loc.end.col;
                let msg = e.message.replace('\\', "\\\\").replace('"', "\\\"");
                diag_entries.push(format!(
                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"parser","severity":"error"}}"#
                ));
                return empty_doc(diag_entries, vec![], vec![]);
            }
        };

        // --- Extract imports from raw AST (before desugar consumes it) ---
        let imports = extract_imports(&parsed);

        // --- Semantic tokens (from raw parsed AST, before desugar) ---
        let mut raw_tokens = Vec::new();
        collect_tokens(&parsed, parsed.root, &mut raw_tokens);
        let semantic_tokens = delta_encode(raw_tokens);

        // --- Empty document: skip desugar ---
        let root_node = parsed.nodes.get(parsed.root);
        let is_empty = matches!(&root_node.kind, NodeKind::Module { exprs, .. } if exprs.items.is_empty());
        if is_empty {
            return empty_doc(diag_entries, semantic_tokens, imports);
        }

        let desugared = match passes::desugar(parsed) {
            Ok(r) => r,
            Err(e) => {
                let line = e.loc.start.line.saturating_sub(1);
                let col = e.loc.start.col;
                let end_line = e.loc.end.line.saturating_sub(1);
                let end_col = e.loc.end.col;
                let msg = e.message.replace('\\', "\\\\").replace('"', "\\\"");
                diag_entries.push(format!(
                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"desugar","severity":"error"}}"#
                ));
                return empty_doc(diag_entries, semantic_tokens, imports);
            }
        };

        let ast = &desugared.ast;
        let scope_result = &desugared.scope;

        // --- Build bind location table ---
        let bind_count = scope_result.binds.len();
        let mut bind_locs: Vec<Option<Loc>> = Vec::with_capacity(bind_count);
        for i in 0..bind_count {
            let bind_id = BindId(i as u32);
            let bind_info = scope_result.binds.get(bind_id);
            let loc = match bind_info.origin {
                BindOrigin::Ast(ast_id) => {
                    ast.nodes.try_get(ast_id)
                        .map(|node| ast_loc(node))
                }
                BindOrigin::Builtin(_) => None,
            };
            bind_locs.push(loc);
        }

        // --- Build reverse map: AstId → BindId for binding sites ---
        let mut ast_to_bind: std::collections::HashMap<AstId, BindId> =
            std::collections::HashMap::new();
        for i in 0..bind_count {
            let bind_id = BindId(i as u32);
            let bind_info = scope_result.binds.get(bind_id);
            if let BindOrigin::Ast(ast_id) = bind_info.origin {
                ast_to_bind.insert(ast_id, bind_id);
            }
        }

        // --- Build reference table and ident index ---
        let mut bind_refs: Vec<Vec<Loc>> = vec![Vec::new(); bind_count];
        let mut idents: Vec<IdentEntry> = Vec::new();

        // Track which binds are referenced (for unused detection)
        let mut used_binds: HashSet<u32> = HashSet::new();

        // Walk all AST nodes to find Ident nodes
        for i in 0..ast.nodes.len() {
            let ast_id = AstId(i as u32);
            let Some(node) = ast.nodes.try_get(ast_id) else { continue };
            let NodeKind::Ident(name) = &node.kind else { continue };

            let loc = ast_loc(node);

            // Check if this ident is a reference that resolves to a binding
            let ref_bind_id = scope_result.resolution.try_get(ast_id)
                .and_then(|opt| *opt);

            if let Some(bid) = ref_bind_id {
                used_binds.insert(bid.0);
                bind_refs[bid.0 as usize].push(loc);
            }

            // Determine the BindId: either from resolution (reference) or
            // from the reverse map (binding site)
            let is_binding_site = ast_to_bind.contains_key(&ast_id);
            let entry_bind_id = ref_bind_id.or_else(|| ast_to_bind.get(&ast_id).copied());

            idents.push(IdentEntry { loc, name: name.to_string(), bind_id: entry_bind_id, is_binding_site });
        }

        // --- Unresolved name diagnostics ---
        // Iterate scope events to find unresolved references
        for i in 0..scope_result.scopes.len() {
            let scope_id = scopes::ScopeId(i as u32);
            if let Some(events) = scope_result.scope_events.try_get(scope_id) {
                for event in events {
                    if let ScopeEvent::Ref(ref_info) = event {
                        if ref_info.kind == RefKind::Unresolved {
                            if let Some(node) = ast.nodes.try_get(ref_info.ast_id) {
                                let line = node.loc.start.line.saturating_sub(1);
                                let col = node.loc.start.col;
                                let end_line = node.loc.end.line.saturating_sub(1);
                                let end_col = node.loc.end.col;
                                let name = match &node.kind {
                                    NodeKind::Ident(s) => s.replace('\\', "\\\\").replace('"', "\\\""),
                                    _ => "?".to_string(),
                                };
                                diag_entries.push(format!(
                                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unresolved name '{name}'","source":"name_res","severity":"error"}}"#
                                ));
                            }
                        }
                    }
                }
            }
        }

        // --- Unused binding diagnostics ---
        // Module-level bindings are exports — skip unused warning for those.
        let module_scope_id = scopes::ScopeId(0);
        for i in 0..bind_count {
            let bind_id = BindId(i as u32);
            if used_binds.contains(&(i as u32)) { continue; }

            let bind_info = scope_result.binds.get(bind_id);

            // Skip builtins
            if matches!(bind_info.origin, BindOrigin::Builtin(_)) { continue; }

            // Skip module-level bindings (they are exports)
            if bind_info.scope == module_scope_id { continue; }

            // Skip non-module scopes whose kind is Module (shouldn't happen,
            // but be safe) and skip Arm scopes (pattern bindings)
            let scope_info = scope_result.scopes.get(bind_info.scope);
            if scope_info.kind == ScopeKind::Module { continue; }

            let BindOrigin::Ast(ast_id) = bind_info.origin else { continue };
            let Some(node) = ast.nodes.try_get(ast_id) else { continue };

            // Only warn for user-written Ident bindings
            let NodeKind::Ident(name) = &node.kind else { continue };

            let line = node.loc.start.line.saturating_sub(1);
            let col = node.loc.start.col;
            let end_line = node.loc.end.line.saturating_sub(1);
            let end_col = node.loc.end.col;
            let name = name.replace('\\', "\\\\").replace('"', "\\\"");
            diag_entries.push(format!(
                r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unused binding '{name}'","source":"name_res","severity":"warning"}}"#
            ));
        }

        // Sort idents by position for binary search
        idents.sort_by(|a, b| a.loc.line.cmp(&b.loc.line).then(a.loc.col.cmp(&b.loc.col)));

        ParsedDocument {
            semantic_tokens,
            diagnostics: format!("[{}]", diag_entries.join(",")),
            bind_locs,
            bind_refs,
            idents,
            imports,
        }
    }

    /// Return delta-encoded semantic tokens.
    pub fn get_semantic_tokens(&self) -> Vec<u32> {
        self.semantic_tokens.clone()
    }

    /// Return JSON diagnostics string.
    pub fn get_diagnostics(&self) -> String {
        self.diagnostics.clone()
    }

    /// Look up the definition site for the identifier at (line, col).
    /// Returns [def_line, def_col, def_end_line, def_end_col] or empty.
    pub fn get_definition(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_id) = self.find_bind_at(line, col) else { return vec![] };
        let Some(loc) = self.bind_locs[bind_id.0 as usize] else { return vec![] };
        vec![loc.line, loc.col, loc.end_line, loc.end_col]
    }

    /// Return JSON import metadata.
    /// Format: [{"url":"./foo.fnk","names":[{"name":"x","line":0,"col":1,"endLine":0,"endCol":2},...]}]
    pub fn get_imports(&self) -> String {
        let mut entries: Vec<String> = Vec::new();
        for imp in &self.imports {
            let url = imp.url.replace('\\', "\\\\").replace('"', "\\\"");
            let names: Vec<String> = imp.names.iter().map(|n| {
                let name = n.name.replace('\\', "\\\\").replace('"', "\\\"");
                format!(
                    r#"{{"name":"{name}","line":{},"col":{},"endLine":{},"endCol":{}}}"#,
                    n.loc.line, n.loc.col, n.loc.end_line, n.loc.end_col
                )
            }).collect();
            let ul = &imp.url_loc;
            entries.push(format!(
                r#"{{"url":"{url}","urlLine":{},"urlCol":{},"urlEndLine":{},"urlEndCol":{},"names":[{}]}}"#,
                ul.line, ul.col, ul.end_line, ul.end_col, names.join(",")
            ));
        }
        format!("[{}]", entries.join(","))
    }

    /// Look up a module-level binding by name.
    /// Returns [line, col, end_line, end_col] or empty if not found.
    /// Used to find where a name is exported in a target module.
    pub fn get_module_binding(&self, name: &str) -> Vec<u32> {
        for entry in &self.idents {
            if entry.is_binding_site && entry.name == name {
                return vec![entry.loc.line, entry.loc.col, entry.loc.end_line, entry.loc.end_col];
            }
        }
        vec![]
    }

    /// Find all references to the identifier at (line, col), including the binding site.
    /// Returns [line, col, end_line, end_col, ...] (4 u32s per location) or empty.
    /// First entry is always the binding site.
    pub fn get_references(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_id) = self.find_bind_at(line, col) else { return vec![] };

        let mut locs = Vec::new();

        // Binding site first
        if let Some(loc) = self.bind_locs[bind_id.0 as usize] {
            locs.push(loc.line);
            locs.push(loc.col);
            locs.push(loc.end_line);
            locs.push(loc.end_col);
        }

        // All references
        for ref_loc in &self.bind_refs[bind_id.0 as usize] {
            locs.push(ref_loc.line);
            locs.push(ref_loc.col);
            locs.push(ref_loc.end_line);
            locs.push(ref_loc.end_col);
        }

        locs
    }
}

impl ParsedDocument {
    /// Find the BindId for the identifier at (line, col).
    /// Returns None if no identifier found or it doesn't resolve.
    fn find_bind_at(&self, line: u32, col: u32) -> Option<BindId> {
        for entry in &self.idents {
            if entry.loc.line == line && entry.loc.col <= col && col < entry.loc.end_col {
                return entry.bind_id;
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Source-map highlighting support for fink compiler test files.
//
// Test files contain pairs of blocks:
//
//   test 'name', fn:
//     expect gen_wat ƒink:
//       <input>
//     | equals wat":
//       <expected output>
//       ;; sm:<base64>
//
// or with a ƒink expectation:
//
//     | equals ƒink:
//       <expected output>
//       # sm:<base64>
//
// `get_sm_mappings(src)` finds every such pair and returns the decoded
// mappings as document-absolute line/col ranges, so the TS side can light up
// matching spans on hover/click without decoding the payload itself.
// ---------------------------------------------------------------------------

/// A position→(line,col) lookup over a block's raw source text, accounting for
/// dedent: source indices skip the block's leading indentation on each line.
///
/// We walk the block content once, building a table that maps every byte of
/// the dedented string to the absolute (line, col) in the original source.
struct BlockMap {
    /// For each byte in the dedented content, its absolute doc line (0-based).
    lines: Vec<u32>,
    /// For each byte in the dedented content, its absolute doc column (0-based, UTF-16 units).
    cols: Vec<u32>,
    /// Total length of the dedented content in bytes.
    dedented_len: u32,
    /// Absolute doc line of the position one past the last char.
    end_line: u32,
    /// Absolute doc UTF-16 column of the position one past the last char.
    end_col: u32,
}

impl BlockMap {
    /// Build a map for a block whose raw source text is `block_text`, starting
    /// at absolute doc line `start_line` and UTF-16 column `start_col`. The
    /// dedent `strip` is the number of leading-whitespace characters removed
    /// from each content line (except possibly blank lines, which are
    /// preserved as empty).
    ///
    /// `block_text` may begin mid-line (the first line's indent is NOT
    /// stripped) or at the start of a line. In fink's block body case, the
    /// first body line starts after the block header, so we always pass the
    /// body text starting at the first body-content character.
    ///
    /// The map is byte-indexed (one entry per UTF-8 byte of the dedented
    /// content) but stores columns in UTF-16 units to match VSCode's
    /// position encoding.
    fn build(block_text: &str, start_line: u32, start_col: u32, strip: u32) -> Self {
        let mut lines = Vec::with_capacity(block_text.len());
        let mut cols = Vec::with_capacity(block_text.len());

        let mut line = start_line;
        let mut col = start_col;
        let mut first_line = true;
        let mut at_line_start = false;

        // Walk character by character; for each char, push (line, col) once
        // per UTF-8 byte it occupies so that dedented byte offsets map back
        // to the correct UTF-16 column.
        let mut chars = block_text.char_indices().peekable();
        while let Some((_byte_pos, ch)) = chars.next() {
            // At start of a non-first line, skip up to `strip` spaces/tabs.
            if at_line_start {
                at_line_start = false;
                let mut skipped = 0u32;
                let mut current = ch;
                loop {
                    if skipped >= strip { break; }
                    if current != ' ' && current != '\t' { break; }
                    skipped += 1;
                    col += 1;
                    // Consume; peek the next to continue the loop.
                    match chars.next() {
                        Some((_, next_ch)) => current = next_ch,
                        None => {
                            let dl = lines.len() as u32;
                            return BlockMap {
                                lines,
                                cols,
                                dedented_len: dl,
                                end_line: line,
                                end_col: col,
                            };
                        }
                    }
                }
                // `current` now points at the first un-skipped char.
                // Emit it and fall through to normal handling.
                if current == '\n' {
                    // Line was blank (or only had whitespace <= strip); emit newline.
                    lines.push(line);
                    cols.push(col);
                    line += 1;
                    col = 0;
                    first_line = false;
                    at_line_start = true;
                    continue;
                }
                // Push one (line, col) per byte of `current`.
                let n_bytes = current.len_utf8();
                let w = current.len_utf16() as u32;
                for _ in 0..n_bytes {
                    lines.push(line);
                    cols.push(col);
                }
                col += w;
                continue;
            }

            if ch == '\n' {
                lines.push(line);
                cols.push(col);
                line += 1;
                col = 0;
                first_line = false;
                at_line_start = true;
                continue;
            }

            let n_bytes = ch.len_utf8();
            let w = ch.len_utf16() as u32;
            for _ in 0..n_bytes {
                lines.push(line);
                cols.push(col);
            }
            col += w;
        }

        let _ = first_line;
        let dedented_len = lines.len() as u32;
        BlockMap { lines, cols, dedented_len, end_line: line, end_col: col }
    }

    /// Translate a dedented byte offset to (line, col). Offsets at or past the
    /// end of content return the position one past the last character.
    fn pos_at(&self, off: u32) -> (u32, u32) {
        let n = self.lines.len();
        if n == 0 { return (self.end_line, self.end_col); }
        if (off as usize) < n {
            (self.lines[off as usize], self.cols[off as usize])
        } else {
            (self.end_line, self.end_col)
        }
    }
}

/// A located block extracted from the source: its dedented-byte origin and
/// the map needed to turn dedented offsets back into absolute positions.
#[allow(dead_code)]
struct SmBlock {
    /// Absolute byte offset in `src` of the first content byte (after any
    /// leading indent has been skipped on line 1). Used only for locating
    /// adjacent sm comments.
    content_end_byte: u32,
    /// Indent level of the block's content lines (for scanning the
    /// trailing `# sm:` comment on a ƒink block).
    indent: u32,
    /// The BlockMap for dedented-byte → (line, col) resolution.
    map: BlockMap,
    /// The line number of the block's last content line (used to locate the
    /// sm comment that should follow).
    last_content_line: u32,
    /// The sm payload base64 string, extracted from the trailing comment if
    /// this is an expectation block. `None` if no payload was found here.
    sm_payload: Option<String>,
}

/// Compute dedent strip-level and content-start byte for a ƒink Block's body.
/// Given the source text and the body's first-item byte range, walk backwards
/// to the start of that line and find the common leading-whitespace across
/// subsequent body lines (same rule as the lexer uses for block strings).
fn compute_fink_block_content(
    src: &str,
    first_byte: u32,
    last_byte: u32,
) -> Option<(u32, u32, u32, u32, u32)> {
    // Returns (content_start_byte, content_end_byte, strip, first_line, first_col).
    let s = src.as_bytes();
    let first = first_byte as usize;
    let last = (last_byte as usize).min(s.len());
    if first >= s.len() { return None; }

    // Walk back to start of the first content line.
    let mut line_start = first;
    while line_start > 0 && s[line_start - 1] != b'\n' {
        line_start -= 1;
    }

    // The first content char's column = first - line_start (byte col ≈ char col for ASCII indent).
    let first_col = (first - line_start) as u32;
    let strip = first_col;

    // Compute absolute (line, col) of line_start: scan from 0.
    let mut ln = 0u32;
    for i in 0..line_start {
        if s[i] == b'\n' { ln += 1; }
    }
    let first_line = ln;

    // Content range in source: from `first` (actual content start after indent)
    // through last content byte on the block's last line. We use `last` as
    // given (end of last body item in the AST).
    //
    // Extend to end of that line, so the block content includes any trailing
    // whitespace but NOT the following line. Actually stop at `last` — trailing
    // whitespace on the last line isn't part of anything meaningful here.
    let content_start_byte = first as u32;
    let content_end_byte = last as u32;

    Some((content_start_byte, content_end_byte, strip, first_line, first_col))
}

/// Collect every "block-literal argument" node in the AST (ƒink Block or
/// StrRawTempl with `":` open) in document order.
fn collect_sm_candidates(ast: &Ast, id: AstId, out: &mut Vec<AstId>) {
    let node = ast.nodes.get(id);
    match &node.kind {
        NodeKind::Block { name, .. } => {
            let name_node = ast.nodes.get(*name);
            if matches!(&name_node.kind, NodeKind::Ident("ƒink")) {
                out.push(id);
            }
            // Don't recurse into ƒink block bodies — nested test DSLs possible but
            // the sm comment is attached to the outer expectation block.
            // Still recurse into others.
            if let NodeKind::Block { body, .. } = &node.kind {
                for c in body.items.iter() {
                    collect_sm_candidates(ast, *c, out);
                }
            }
        }
        NodeKind::StrRawTempl { open, children, .. } => {
            if open.src == "\":" {
                out.push(id);
            }
            for c in children.iter() {
                collect_sm_candidates(ast, *c, out);
            }
        }

        // Recurse into all container kinds.
        NodeKind::Module { exprs: children, .. }
        | NodeKind::LitSeq { items: children, .. }
        | NodeKind::LitRec { items: children, .. }
        | NodeKind::Patterns(children) => {
            for c in children.items.iter() {
                collect_sm_candidates(ast, *c, out);
            }
        }
        NodeKind::Apply { func, args } => {
            collect_sm_candidates(ast, *func, out);
            for a in args.items.iter() {
                collect_sm_candidates(ast, *a, out);
            }
        }
        NodeKind::Pipe(children) => {
            for c in children.items.iter() {
                collect_sm_candidates(ast, *c, out);
            }
        }
        NodeKind::Fn { params, body, .. } => {
            collect_sm_candidates(ast, *params, out);
            for e in body.items.iter() {
                collect_sm_candidates(ast, *e, out);
            }
        }
        NodeKind::InfixOp { lhs, rhs, .. }
        | NodeKind::Bind { lhs, rhs, .. }
        | NodeKind::BindRight { lhs, rhs, .. }
        | NodeKind::Member { lhs, rhs, .. } => {
            collect_sm_candidates(ast, *lhs, out);
            collect_sm_candidates(ast, *rhs, out);
        }
        NodeKind::UnaryOp { operand, .. } => collect_sm_candidates(ast, *operand, out),
        NodeKind::Group { inner, .. } | NodeKind::Try(inner) => collect_sm_candidates(ast, *inner, out),
        NodeKind::Spread { inner: Some(inner), .. } => collect_sm_candidates(ast, *inner, out),
        NodeKind::StrTempl { children, .. } => {
            for c in children.iter() {
                collect_sm_candidates(ast, *c, out);
            }
        }
        NodeKind::Match { subjects, arms, .. } => {
            for s in subjects.items.iter() {
                collect_sm_candidates(ast, *s, out);
            }
            for a in arms.items.iter() {
                collect_sm_candidates(ast, *a, out);
            }
        }
        NodeKind::Arm { lhs, body, .. } => {
            collect_sm_candidates(ast, *lhs, out);
            for e in body.items.iter() {
                collect_sm_candidates(ast, *e, out);
            }
        }
        NodeKind::ChainedCmp(parts) => {
            for part in parts.iter() {
                if let fink::ast::CmpPart::Operand(op) = part {
                    collect_sm_candidates(ast, *op, out);
                }
            }
        }
        _ => {}
    }
}

/// Build SmBlock data from a single AST candidate node.
/// `sm_payload` is only set when a trailing sm comment is found in the source.
fn build_sm_block(src: &str, ast: &Ast, id: AstId) -> Option<SmBlock> {
    let node = ast.nodes.get(id);

    match &node.kind {
        NodeKind::Block { body, .. } => {
            // ƒink: block — use source text of body range for BlockMap.
            let first_item = body.items.first()?;
            let last_item = body.items.last()?;
            let first_node = ast.nodes.get(*first_item);
            let last_node = ast.nodes.get(*last_item);
            let first_byte = first_node.loc.start.idx;
            let last_byte = last_node.loc.end.idx;

            let (cs, ce, strip, first_line, first_col) =
                compute_fink_block_content(src, first_byte, last_byte)?;

            let block_text = &src[cs as usize .. ce as usize];
            // first line of block_text starts with zero indent (we already pointed
            // at the first content char); subsequent lines are full source lines
            // with `strip` bytes of leading indent we want to strip.
            let map = BlockMap::build(block_text, first_line, first_col, strip);

            // Determine last_content_line: scan source to find the line of the
            // last content byte.
            let mut ln = 0u32;
            let sbytes = src.as_bytes();
            for i in 0..(ce as usize).min(sbytes.len()) {
                if sbytes[i] == b'\n' { ln += 1; }
            }
            let last_content_line = ln;

            // Look for a trailing `# sm:<base64>` comment immediately after
            // this block's content, indented at `strip`.
            let sm_payload = scan_sm_comment_after(src, ce, strip, "# sm:");

            Some(SmBlock {
                content_end_byte: ce,
                indent: strip,
                map,
                last_content_line,
                sm_payload,
            })
        }
        NodeKind::StrRawTempl { children, open, close, .. } if open.src == "\":" => {
            // wat": block — content is composed of LitStr segments. For our
            // tests these are always a single LitStr with the full raw body.
            // We extract the content text from the source between open.end and
            // close.start (which is the dedent marker).
            let content_start = open.loc.end.idx;
            let content_end = close.loc.start.idx;
            if content_end <= content_start || (content_end as usize) > src.len() {
                return None;
            }

            // Use the first LitStr child's indent to determine strip level.
            let strip = children.iter().find_map(|cid| {
                if let NodeKind::LitStr { indent, .. } = &ast.nodes.get(*cid).kind {
                    Some(*indent)
                } else {
                    None
                }
            }).unwrap_or(0);

            // Walk back from content_start to find line start; compute first_line/first_col.
            // For `wat":\n   foo`, content_start is right after `":`, which sits
            // at end of the header line. The first actual content starts on the
            // next line, after `strip` bytes of indent.
            let sbytes = src.as_bytes();
            let mut ln = 0u32;
            for i in 0..(content_start as usize).min(sbytes.len()) {
                if sbytes[i] == b'\n' { ln += 1; }
            }
            // content_start points at the newline following `":` (or right after it).
            // Skip leading newline + first-line indent to get to first content char.
            let mut i = content_start as usize;
            // Skip the first newline character.
            if i < sbytes.len() && sbytes[i] == b'\n' { i += 1; ln += 1; }
            // Skip `strip` spaces.
            let content_first_byte = i + (strip as usize).min(
                sbytes[i..(content_end as usize).min(sbytes.len())]
                    .iter()
                    .position(|&b| b != b' ')
                    .unwrap_or(0)
            );

            let first_col = strip;
            let first_line = ln;

            // Block text includes from the first content char to content_end.
            let block_text = &src[content_first_byte .. content_end as usize];
            // But we want to trim the trailing `;; sm:…` line from block_text
            // before building the map — the sm comment is inside the raw
            // content but NOT inside the sourcemap coordinate space.
            let (text_for_map, sm_payload) = split_trailing_sm_line(block_text, ";; sm:");

            let map = BlockMap::build(text_for_map, first_line, first_col, strip);

            // Compute last_content_line from the trimmed text length.
            let trimmed_end_byte = content_first_byte + text_for_map.len();
            let mut lc = 0u32;
            for i in 0..trimmed_end_byte.min(sbytes.len()) {
                if sbytes[i] == b'\n' { lc += 1; }
            }

            Some(SmBlock {
                content_end_byte: trimmed_end_byte as u32,
                indent: strip,
                map,
                last_content_line: lc,
                sm_payload,
            })
        }
        _ => None,
    }
}

/// Scan source for a `<prefix><base64>` comment immediately after `from_byte`,
/// indented at exactly `indent` spaces. Returns the base64 payload.
fn scan_sm_comment_after(src: &str, from_byte: u32, indent: u32, prefix: &str) -> Option<String> {
    let s = src.as_bytes();
    let mut i = from_byte as usize;
    // Skip to start of next line.
    while i < s.len() && s[i] != b'\n' { i += 1; }
    if i >= s.len() { return None; }
    i += 1; // past the newline

    // Require `indent` spaces.
    let line_start = i;
    let mut spaces = 0u32;
    while spaces < indent && i < s.len() && s[i] == b' ' {
        spaces += 1;
        i += 1;
    }
    if spaces < indent { return None; }

    // Check for prefix.
    let pb = prefix.as_bytes();
    if i + pb.len() > s.len() { return None; }
    if &s[i..i + pb.len()] != pb { return None; }
    i += pb.len();

    // Read base64 payload to end of line.
    let start = i;
    while i < s.len() && s[i] != b'\n' { i += 1; }
    let end = i;

    // Trim trailing whitespace.
    let mut actual_end = end;
    while actual_end > start && (s[actual_end - 1] == b' ' || s[actual_end - 1] == b'\t' || s[actual_end - 1] == b'\r') {
        actual_end -= 1;
    }
    let _ = line_start;
    Some(src[start..actual_end].to_string())
}

/// Split a raw-string content at its trailing sm comment line.
/// Returns (text_before_sm_line, Some(payload)) or (full_text, None).
/// The sm line is `<indent><prefix><base64>` with indent matching the block.
fn split_trailing_sm_line<'a>(text: &'a str, prefix: &str) -> (&'a str, Option<String>) {
    // Find last newline; the sm line (if any) is on the final line.
    // But block content may end with `\n` before dedent — we want the last
    // non-empty line.
    let bytes = text.as_bytes();
    let mut end = bytes.len();
    // Strip trailing empty lines/whitespace.
    while end > 0 && (bytes[end - 1] == b'\n' || bytes[end - 1] == b' ' || bytes[end - 1] == b'\r' || bytes[end - 1] == b'\t') {
        end -= 1;
    }
    // Find start of final line.
    let mut line_start = end;
    while line_start > 0 && bytes[line_start - 1] != b'\n' {
        line_start -= 1;
    }
    let line = &text[line_start..end];
    // The sm line may be indented; trim leading whitespace.
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix(prefix) {
        // Strip trailing whitespace from rest.
        let payload = rest.trim().to_string();
        // Return text up to and including the newline before line_start.
        // `line_start` is the position right after the newline that ended the
        // previous line, so `line_start - 1` is that newline. We want the
        // text BEFORE that newline (so the sm line is fully excluded).
        let chop = if line_start > 0 && bytes[line_start - 1] == b'\n' {
            line_start - 1
        } else {
            line_start
        };
        (&text[..chop], Some(payload))
    } else {
        (text, None)
    }
}

/// Decode a base64url sourcemap payload using fink's SourceMap decoder.
fn decode_sm(payload: &str) -> Option<SourceMap> {
    SourceMap::decode_base64url(payload).ok()
}

/// For each mapping, compute the output span's (start, end) in the dedented
/// output-block text. The "span" runs from this mapping's `out` until the
/// next mapping's `out` (or end of output).
fn output_spans(sm: &SourceMap, output_len: u32) -> Vec<(u32, u32)> {
    let n = sm.mappings.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = sm.mappings[i].out;
        let end = if i + 1 < n { sm.mappings[i + 1].out } else { output_len };
        out.push((start, end));
    }
    out
}

/// Emit the full JSON payload for TS consumption.
///
/// Shape:
///   [
///     {
///       "mappings": [
///         {
///           "out":{"line":N,"col":N,"endLine":N,"endCol":N},
///           "src":{"line":N,"col":N,"endLine":N,"endCol":N}   // may be omitted
///         },
///         ...
///       ]
///     },
///     ...
///   ]
#[wasm_bindgen]
pub fn get_sm_mappings(src: &str) -> String {
    let parsed = match passes::parse(src, "") {
        Ok(r) => r,
        Err(_) => return "[]".to_string(),
    };

    let mut candidates = Vec::new();
    collect_sm_candidates(&parsed, parsed.root, &mut candidates);

    // Order by document position.
    candidates.sort_by_key(|id| parsed.nodes.get(*id).loc.start.idx);

    // Build every candidate block up-front so we can find expectation blocks
    // (those with an sm payload) and pair each with its immediate predecessor
    // (the input block in the same assertion).
    let built: Vec<Option<SmBlock>> = candidates
        .iter()
        .map(|id| build_sm_block(src, &parsed, *id))
        .collect();

    let mut groups: Vec<String> = Vec::new();
    for (i, maybe_expect) in built.iter().enumerate() {
        let Some(expect_block) = maybe_expect else { continue };
        let Some(payload) = &expect_block.sm_payload else { continue };
        if i == 0 { continue };
        let Some(input_block) = &built[i - 1] else { continue };

        let Some(sm) = decode_sm(payload) else { continue };

        let out_len = expect_block.map.dedented_len;
        let spans = output_spans(&sm, out_len);

        let mut mapping_strs: Vec<String> = Vec::new();
        for (idx, m) in sm.mappings.iter().enumerate() {
            let (out_s, out_e) = spans[idx];
            let (out_sl, out_sc) = expect_block.map.pos_at(out_s);
            let (out_el, out_ec) = expect_block.map.pos_at(out_e);
            let src_json = if let Some(sr) = m.src {
                let (sl, sc) = input_block.map.pos_at(sr.start);
                let (el, ec) = input_block.map.pos_at(sr.end);
                format!(
                    r#","src":{{"line":{sl},"col":{sc},"endLine":{el},"endCol":{ec}}}"#
                )
            } else {
                String::new()
            };
            mapping_strs.push(format!(
                r#"{{"out":{{"line":{out_sl},"col":{out_sc},"endLine":{out_el},"endCol":{out_ec}}}{src_json}}}"#
            ));
        }

        groups.push(format!(r#"{{"mappings":[{}]}}"#, mapping_strs.join(",")));
    }

    format!("[{}]", groups.join(","))
}
