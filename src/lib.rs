use std::collections::HashSet;
use wasm_bindgen::prelude::*;

use fink::ast::{Ast, AstId, Node, NodeKind};
use fink::lexer::{self, TokenKind};
use fink::passes;
use fink::passes::scopes::{self, BindId, BindOrigin, RefKind, ScopeEvent, ScopeKind};

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
    /// The BindId this ident resolves to (if it's a reference),
    /// or the BindId it defines (if it's a binding site).
    bind_id: Option<BindId>,
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
        let empty_doc = |diag_entries: Vec<String>, semantic_tokens: Vec<u32>| ParsedDocument {
            semantic_tokens,
            diagnostics: format!("[{}]", diag_entries.join(",")),
            bind_locs: vec![],
            bind_refs: vec![],
            idents: vec![],
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
                return empty_doc(diag_entries, vec![]);
            }
        };

        // --- Semantic tokens (from raw parsed AST, before desugar) ---
        let mut raw_tokens = Vec::new();
        collect_tokens(&parsed, parsed.root, &mut raw_tokens);
        let semantic_tokens = delta_encode(raw_tokens);

        // --- Empty document: skip desugar ---
        let root_node = parsed.nodes.get(parsed.root);
        let is_empty = matches!(&root_node.kind, NodeKind::Module { exprs, .. } if exprs.items.is_empty());
        if is_empty {
            return empty_doc(diag_entries, semantic_tokens);
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
                return empty_doc(diag_entries, semantic_tokens);
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
            if !matches!(&node.kind, NodeKind::Ident(_)) { continue; }

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
            let entry_bind_id = ref_bind_id.or_else(|| ast_to_bind.get(&ast_id).copied());

            idents.push(IdentEntry { loc, bind_id: entry_bind_id });
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
