// Tagged-template helper for writing TextMate regexes across multiple lines.
//
// `rx` lets a pattern be written with indentation and inline `# ...` comments
// for readability; both are stripped before the pattern is emitted. It also
// collapses an escaped backslash that precedes `#`, `'` or `"` back to a single
// backslash, so those characters can be written escaped in the source without
// the escape surviving into the output.
const ignorables = /(\s+#.*\n)|((\n|\s)*)/g;
const esc = /(^|[^\\])((\\{2})*)\\(?=[#'"])/g;

export const rx = (strings, ...exprs) => {
  const parts = strings.raw.map((part) =>
    part.replace(ignorables, '').replace(esc, '$1$3')
  );
  return String.raw({raw: parts}, ...exprs);
};
