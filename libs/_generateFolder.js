const SearchDir             = require('./searchDir');
const path                  = require('path');

require('dotenv').config();

const entryPath = process.env.DIR_ENTRY_UTILITY;
const dir = SearchDir(entryPath, ['core, package','editorjs']);

for (key in dir)
{
    dir[key] = {
        import: `${entryPath}${dir[key]}/index.js`,
    };
}

module.exports = dir;