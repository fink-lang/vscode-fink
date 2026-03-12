use wasm_bindgen::prelude::*;

use fink::ast::{Node, NodeKind};
use fink::parser;

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
