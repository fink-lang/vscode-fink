const {IndentAction, languages} = require('vscode');

const wordPattern = /(-?\d*\.\d\w*)|([^`~!@$^&*()=+[{\]}\\|;:'",.<>/\s]+)/g;


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
    {
      beforeText: /^.+`$/,
      afterText: /`$/,
      action: {
        indentAction: IndentAction.Indent
      }
    },
    {
      beforeText: /^[^`\s]+`$/,
      afterText: /$/,
      action: {
        indentAction: IndentAction.Outdent
      }
    }
  ]
};


const activate=(context)=> {
  languages.setLanguageConfiguration('jsx', jsxConfiguration);
  languages.setLanguageConfiguration('jsx-attr', jsxAttrConfiguration);
  languages.setLanguageConfiguration('fink', fink_conf);
};


exports.activate = activate;
