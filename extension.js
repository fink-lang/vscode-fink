const {
  IndentAction, languages, MarkdownString, CompletionItem, SnippetString
} = require('vscode');


const wordPattern = /(-?\d*\.\d\w*)|([^`~!@$^&*()=+\-[{\]}\\|;:'",.<>/\s]+)/g;


const jsxConfiguration = {
  wordPattern,
  onEnterRules: [
    {
      beforeText: /.*/,
      afterText: /\/>/,
      action: {indentAction: IndentAction.IndentOutdent}
    }
  ]
};

const jsxAttrConfiguration = {
  wordPattern,
  onEnterRules: [
    {
      beforeText: />/,
      afterText: /<\//,
      action: {indentAction: IndentAction.IndentOutdent}
    }
  ]
};


const fink_conf = {
  wordPattern,
  onEnterRules: [
    { // match doc comment
      beforeText: /^\s*---\s*$/,
      action: {indentAction: IndentAction.None}
    },
    { // match end of str on its own: `|
      beforeText: /^\s*[`'"]{1}\s*$/,
      afterText: /^$/,
      action: {indentAction: IndentAction.Outdent}
    },
    { // match first indentation after auto closing: `|`
      beforeText: /^.*[`'"]{1}\s*$/,
      afterText: /^[`'"]$/,
      action: {indentAction: IndentAction.Indent}
    },
    { // match first indentating existing: foo = `| spam...
      beforeText: /^.+[=,:(]\s*[`'"]{1}\s*$/,
      action: {indentAction: IndentAction.Indent}
    },
    { // match operators and blocks: fold ...:|
      beforeText: /^.+[:=+<\-/*]{1}\s*$/,
      action: {indentAction: IndentAction.Indent}
    }
  ]
};


const doc_md = (header, code)=> {
  const doc = new MarkdownString(header);
  doc.appendCodeblock(code, 'fink');
  return doc;
};


const snippet = (txt)=> new SnippetString(txt);


const api = {
  match: {
    doc: doc_md(
      'Return the first result of `test: result` where foo matches `test`.',
      `match foo:
  test: result
  {bar: 'spam'}: shrub
  [bar, 'spam']: shrub
  'spam': shrub
  else: ni
`),
    snippet: snippet('match $1:\n  $2: $3\n  else: $4\n$0')
  },

  map: {
    doc: doc_md(
      'Return a function `fn iterable:` that maps each `item` of `iterable`.',
      `pipe [1, 2, 3]:
  map item:
    item * 2

# == [2, 4, 6]
`),
    snippet: snippet('map $1:\n  $2\n$0')
  },

  fold: {
    doc: doc_md(
      'Return a function `fn iterable:` that reduces all items of `iterable`.' +
      ' to a single value.',
      `pipe [1, 2, 3]:
  fold item, acc=0:
    item + acc

# == 6
`),
    snippet: snippet('fold $1, $2:\n  $3: $4\n$0')
  },

  unfold: {
    doc: doc_md(
      'Return a function `fn curr:` that generates items from the `curr`' +
      ' value.',
      `count = unfold curr=0:
  (curr + inc, curr + inc)

[a, b, c] = count()
# [0, 1, 2]
`),
    snippet: snippet('unfold $1, $2:\n  ($3, $4)\n$0')
  },

  filter: {
    doc: doc_md(
      'Return a function `fn iterable:` that only yields `item` of `iterable`' +
      ' for which the block returns `true`.',
      `pipe [1, 2, 3, 4]:
  filter item:
    item % 2

# == [2, 4]
`),
    snippet: snippet('filter $1:\n  $2\n$0')
  },

  while: {
    doc: doc_md(
      'Return a function `fn iterable:` that yields each `item` of `iterable`' +
      ' while the block returns true',
      `pipe [1, 2, 3, 4]:
  while item:
    item < 3

# == [1, 2]
`),
    snippet: snippet('while $1:\n  $2\n$0')
  },

  find: {
    doc: doc_md(
      'Return a function `fn iterable:` that returns the first `item` of' +
      ' `iterable` for which the block returns true',
      `pipe [1, 2, 3, 4]:
  find item:
    item > 2

# == 3
`),
    snippet: snippet('find $1:\n  $2\n$0')
  },
  pipe: {
    doc: doc_md(
      'Calls all expressions with the result of the previous call, starting' +
      ' with the pipe arg for the first call.',
      `pipe [1, 2, 3, 4]:
  map item:
    item * 2
  find item:
    item > 4

# == 6
`),
    snippet: snippet('pipe $1:\n  $2\n$0')
  }
};

const provide_hover = (document, position)=> {
  const wr = document.getWordRangeAtPosition(position/* , /\w+/g */);
  const txt = document.getText(wr);

  if (api[txt] === undefined) {
    return;
  }

  const md = api[txt].doc;
  return {
    contents: [md]
  };
};


const comp_item = (key)=> {
  const {doc, snippet: code_snippet} = api[key];

  const item = new CompletionItem(key);
  item.insertText = code_snippet;
  item.documentation = doc;

  return item;
};


const provide_completion_items = ()=> [
  comp_item('match'),
  comp_item('fold'),
  comp_item('unfold'),
  comp_item('map'),
  comp_item('filter'),
  comp_item('while'),
  comp_item('find'),
  comp_item('pipe')
];


const activate = (ctx)=> {
  languages.setLanguageConfiguration('jsx', jsxConfiguration);
  languages.setLanguageConfiguration('jsx-attr', jsxAttrConfiguration);
  languages.setLanguageConfiguration('fink', fink_conf);

  const provider = languages.registerCompletionItemProvider(
    'fink', {provideCompletionItems: provide_completion_items}
  );

  ctx.subscriptions.push(provider);
};

exports.activate = activate;
