use wasm_bindgen::prelude::*;

use fink::ast::{self, Node, NodeKind};
use fink::lexer::{self, TokenKind};
use fink::parser;
use fink::passes::cps::ir::CpsId;
use fink::passes::cps::transform::lower_expr;
use fink::passes::name_res::{self, Resolution};

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
fn resolve_callee<'a>(node: &'a Node<'a>) -> &'a Node<'a> {
    match &node.kind {
        NodeKind::Member { rhs, .. } => resolve_callee(rhs),
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


fn collect_tokens<'src>(node: &'src Node<'src>, tokens: &mut Vec<RawToken>) {
    match &node.kind {
        NodeKind::Apply { func, args } => {
            let callee = resolve_callee(func);
            match &callee.kind {
                NodeKind::Ident(_) => {
                    // Tagged literal: callee adjacent to first arg
                    // Prefix: foo'bar' (callee end == arg start) → tag.left
                    // Postfix: 123foo (arg end == callee start) → tag.right
                    let tag_kind = args.first().and_then(|first_arg| {
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
                NodeKind::Group(_) => {
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
            collect_tokens(func, tokens);
            for arg in args {
                collect_tokens(arg, tokens);
            }
        }

        NodeKind::Pipe(children) => {
            for child in children {
                if matches!(&child.kind, NodeKind::Ident(_)) {
                    emit_token(tokens, child, TOKEN_FUNCTION, 0);
                }
                collect_tokens(child, tokens);
            }
        }

        NodeKind::LitRec(children) => {
            for child in children {
                if let NodeKind::Arm { lhs, body } = &child.kind {
                    if let Some(first_lhs) = lhs.first() {
                        if matches!(&first_lhs.kind, NodeKind::Ident(_)) {
                            if body.is_empty() {
                                emit_token(tokens, first_lhs, TOKEN_VARIABLE, MOD_READONLY);
                            } else {
                                emit_token(tokens, first_lhs, TOKEN_PROPERTY, 0);
                            }
                        }
                    }
                    // Recurse into arm body
                    for expr in body {
                        collect_tokens(expr, tokens);
                    }
                } else {
                    collect_tokens(child, tokens);
                }
            }
        }

        // --- recurse into all other container nodes ---

        NodeKind::LitSeq(children)
        | NodeKind::StrTempl(children)
        | NodeKind::StrRawTempl(children)
        | NodeKind::Patterns(children) => {
            for child in children {
                collect_tokens(child, tokens);
            }
        }

        NodeKind::InfixOp { lhs, rhs, .. } => {
            collect_tokens(lhs, tokens);
            collect_tokens(rhs, tokens);
        }

        NodeKind::Bind { lhs, rhs }
        | NodeKind::BindRight { lhs, rhs }
        | NodeKind::Member { lhs, rhs } => {
            collect_tokens(lhs, tokens);
            collect_tokens(rhs, tokens);
        }

        NodeKind::UnaryOp { operand, .. } => {
            collect_tokens(operand, tokens);
        }

        NodeKind::Group(inner)
        | NodeKind::Try(inner)
        | NodeKind::Yield(inner) => {
            collect_tokens(inner, tokens);
        }

        NodeKind::Spread(Some(inner)) => {
            collect_tokens(inner, tokens);
        }

        NodeKind::Fn { params, body } => {
            collect_tokens(params, tokens);
            for expr in body {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::Match { subjects, arms } => {
            collect_tokens(subjects, tokens);
            for arm in arms {
                collect_tokens(arm, tokens);
            }
        }

        NodeKind::Arm { lhs, body } => {
            // Arms not inside LitRec — just recurse
            for expr in lhs {
                collect_tokens(expr, tokens);
            }
            for expr in body {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::Block { name, params, body } => {
            // Emit namespace token for the block name
            if matches!(&name.kind, NodeKind::Ident(_)) {
                emit_token(tokens, name, TOKEN_BLOCK_NAME, 0);
            }
            collect_tokens(name, tokens);
            collect_tokens(params, tokens);
            for expr in body {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::ChainedCmp(parts) => {
            for part in parts {
                if let fink::ast::CmpPart::Operand(node) = part {
                    collect_tokens(node, tokens);
                }
            }
        }

        // Leaf nodes — no children to recurse into
        NodeKind::Ident(_)
        | NodeKind::LitBool(_)
        | NodeKind::LitInt(_)
        | NodeKind::LitFloat(_)
        | NodeKind::LitDecimal(_)
        | NodeKind::LitStr(_)
        | NodeKind::Partial
        | NodeKind::Wildcard
        | NodeKind::Spread(None) => {}
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

/// Run the lexer, parser, and name resolution to collect all diagnostics.
/// Returns a JSON array: [{"line":0,"col":0,"endLine":0,"endCol":1,"message":"...","source":"...","severity":"error"|"warning"}, ...]
/// Lines are 0-based to match VSCode conventions.
#[wasm_bindgen]
pub fn get_diagnostics(src: &str) -> String {
    let mut entries: Vec<String> = Vec::new();

    // Lexer errors — must register operators to avoid false Err tokens
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
            entries.push(format!(
                r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"lexer","severity":"error"}}"#
            ));
        }
    }

    // Parser error
    match parser::parse(src) {
        Err(e) => {
            let line = e.loc.start.line.saturating_sub(1);
            let col = e.loc.start.col;
            let end_line = e.loc.end.line.saturating_sub(1);
            let end_col = e.loc.end.col;
            let msg = e.message.replace('\\', "\\\\").replace('"', "\\\"");
            entries.push(format!(
                r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"parser","severity":"error"}}"#
            ));
        }
        Ok(result) => {
            // Name resolution — report unresolved names as warnings
            let ast_index = ast::build_index(&result);
            let cps = lower_expr(&result.root);
            let node_count = cps.origin.len();
            let resolved = name_res::resolve(&cps.root, &cps.origin, &ast_index, node_count);

            for i in 0..node_count {
                let cps_id = CpsId(i as u32);
                if let Some(Resolution::Unresolved) = resolved.resolution.get(cps_id) {
                    if let Some(ast_id) = *cps.origin.get(cps_id) {
                        if let Some(node) = *ast_index.get(ast_id) {
                            let line = node.loc.start.line.saturating_sub(1);
                            let col = node.loc.start.col;
                            let end_line = node.loc.end.line.saturating_sub(1);
                            let end_col = node.loc.end.col;
                            let name = match &node.kind {
                                NodeKind::Ident(s) => s.replace('\\', "\\\\").replace('"', "\\\""),
                                _ => "?".to_string(),
                            };
                            entries.push(format!(
                                r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unresolved name '{name}'","source":"name_res","severity":"warning"}}"#
                            ));
                        }
                    }
                }
            }
        }
    }

    format!("[{}]", entries.join(","))
}

/// Extract the bind CpsId from a Resolution variant.
fn resolution_bind_id(res: &Option<Resolution>) -> Option<CpsId> {
    match res {
        Some(Resolution::Local(id))
        | Some(Resolution::Captured { bind: id, .. })
        | Some(Resolution::Recursive(id)) => Some(*id),
        _ => None,
    }
}

/// Parse, find Ident at cursor, lower to CPS, run name resolution, and find
/// the binding CpsId. Emits bindings directly into the caller's scope so that
/// borrows from the parse result live long enough.
/// If the cursor is on a reference, resolves it. If on a binding site, uses it directly.
macro_rules! resolve_bind_at {
    ($src:expr, $line:expr, $col:expr => $ast_index:ident, $cps:ident, $resolved:ident, $bind_cps_id:ident) => {
        let result = match parser::parse($src) {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        let target_line = $line + 1;

        let $ast_index = ast::build_index(&result);
        let ast_count = $ast_index.len();
        let mut target_ast_id = None;
        for i in 0..ast_count {
            let id = ast::AstId(i as u32);
            let Some(node) = *$ast_index.get(id) else { continue };
            if !matches!(&node.kind, NodeKind::Ident(_)) { continue }
            let loc = &node.loc;
            if loc.start.line == target_line && loc.start.col <= $col && $col < loc.end.col {
                target_ast_id = Some(id);
                break;
            }
        }
        let Some(target_ast_id) = target_ast_id else { return vec![] };

        let $cps = lower_expr(&result.root);
        let node_count = $cps.origin.len();

        let mut target_cps_id = None;
        for i in 0..node_count {
            let cps_id = CpsId(i as u32);
            if let Some(ast_id) = *$cps.origin.get(cps_id) {
                if ast_id == target_ast_id {
                    target_cps_id = Some(cps_id);
                    break;
                }
            }
        }
        let Some(target_cps_id) = target_cps_id else { return vec![] };

        let $resolved = name_res::resolve(&$cps.root, &$cps.origin, &$ast_index, node_count);

        // Find the binding CpsId: try as reference first, then as binding site
        let $bind_cps_id = if let Some(id) = resolution_bind_id($resolved.resolution.get(target_cps_id)) {
            id
        } else if $resolved.bind_scope.get(target_cps_id).is_some() {
            target_cps_id
        } else {
            return vec![];
        };
    };
}

/// Look up the definition site for the identifier at (line, col).
/// Returns [def_line, def_col, def_end_line, def_end_col] or empty if no definition found.
#[wasm_bindgen]
pub fn get_definition(src: &str, line: u32, col: u32) -> Vec<u32> {
    resolve_bind_at!(src, line, col => ast_index, cps, _resolved, bind_cps_id);

    let Some(bind_ast_id) = *cps.origin.get(bind_cps_id) else { return vec![] };
    let Some(bind_node) = *ast_index.get(bind_ast_id) else { return vec![] };

    let b = &bind_node.loc;
    vec![
        b.start.line.saturating_sub(1), b.start.col,
        b.end.line.saturating_sub(1), b.end.col,
    ]
}

/// Find all references to the identifier at (line, col), including the binding site.
/// Returns [line, col, end_line, end_col, ...] (4 u32s per location) or empty.
#[wasm_bindgen]
pub fn get_references(src: &str, line: u32, col: u32) -> Vec<u32> {
    resolve_bind_at!(src, line, col => ast_index, cps, resolved, bind_cps_id);

    let mut locs = Vec::new();
    let node_count = cps.origin.len();

    // Include the binding site itself
    if let Some(ast_id) = *cps.origin.get(bind_cps_id) {
        if let Some(node) = *ast_index.get(ast_id) {
            let b = &node.loc;
            locs.push(b.start.line.saturating_sub(1));
            locs.push(b.start.col);
            locs.push(b.end.line.saturating_sub(1));
            locs.push(b.end.col);
        }
    }

    // Find all references that resolve to this binding
    for i in 0..node_count {
        let cps_id = CpsId(i as u32);
        if let Some(id) = resolution_bind_id(resolved.resolution.get(cps_id)) {
            if id == bind_cps_id {
                if let Some(ast_id) = *cps.origin.get(cps_id) {
                    if let Some(node) = *ast_index.get(ast_id) {
                        let b = &node.loc;
                        locs.push(b.start.line.saturating_sub(1));
                        locs.push(b.start.col);
                        locs.push(b.end.line.saturating_sub(1));
                        locs.push(b.end.col);
                    }
                }
            }
        }
    }

    locs
}

#[wasm_bindgen]
pub fn get_semantic_tokens(src: &str) -> Vec<u32> {
    let result = match parser::parse(src) {
        Ok(result) => result,
        Err(_) => return vec![],
    };

    let mut tokens = Vec::new();
    collect_tokens(&result.root, &mut tokens);
    delta_encode(tokens)
}
