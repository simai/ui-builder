const fs = require("fs");
const BundleObj = require('./bundleObj');
require('dotenv').config();

module.exports = function(dir)
{
    const entryPath = process.env.DIR_ENTRY_UTILITY;
    let removeExcessObj = {};
    let ext = process.env.EXT;

    for (key in dir) {
        let pathEntryFile = entryPath + key + '/index.js';
        let fileContent = fs.readFileSync(pathEntryFile, "utf8");

        if(fileContent.indexOf('js') === -1)
        {
            let excessJsFile = {
                'dir' : process.env.DIR_OUTPUT_UTILITY + key + '/js/',
                'file': process.env.DIR_OUTPUT_UTILITY + key + '/js/' + key + ext
            };
            BundleObj(removeExcessObj, key, excessJsFile);
        }
    }
}