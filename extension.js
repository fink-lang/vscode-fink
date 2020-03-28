// eslint-disable-next-line no-undef
const {IndentAction, languages} = require('vscode');

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


const activate=()=> {
  languages.setLanguageConfiguration('jsx', jsxConfiguration);
  languages.setLanguageConfiguration('jsx-attr', jsxAttrConfiguration);
  languages.setLanguageConfiguration('fink', fink_conf);
};


// eslint-disable-next-line no-undef
exports.activate = activate;
