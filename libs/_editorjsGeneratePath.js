const SearchDir             = require('./searchDir');
const BundleObj             = require('./bundleObj');
const path                  = require('path');
const CollectExcessFile     = require('./editorjsExcessFile');

require('dotenv').config();

var pathSrc = __dirname.replace(/\libs/gi, '');

const pathDir = {
    /*core : {
        import : path.resolve(pathSrc, process.env.DIR_ENTRY_CORE),
        filename : '[name]/js/[name].js',
    },*/
};

//1. Find connected plugins. Exclude the core directory
const entryPath = process.env.DIR_ENTRY_EDITORJS;
const dir = SearchDir(entryPath, ['core, package','plugin']);
CollectExcessFile(dir);

//2. Collect configuration files

for (key in dir) {
    dir[key].forEach((subdir) => {
        entry = entryPath + key + '/index.js';
        output = key;
        BundleObj(pathDir, output, entry)
        /*pathDir[key] = {
            import : path.resolve(pathSrc, process.env.DIR_ENTRY_PLUGIN + key + '/index.js'),
            filename : 'plugin/[name]/js/[name].js',
        }*/
    });
}


module.exports = pathDir;
