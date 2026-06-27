import {writeFileSync} from 'fs';

import {lang as fink} from '../grammars/fink.mjs';
import {lang as regex} from '../grammars/regex.mjs';
import {lang as md} from '../grammars/fink-md.mjs';

const build = (lang, filename) => {
  const data = JSON.stringify(lang, null, 2);
  console.log('generating', filename);
  writeFileSync(filename, data);
};

build(fink, './build/pkg/grammars/fink.tmLanguage.json');

build(regex, './build/pkg/grammars/regex.tmLanguage.json');

build(md, './build/pkg/grammars/fink-md.tmLanguage.json');
