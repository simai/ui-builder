const fs = require("fs");
const BundleObj = require('./bundleObj');
require('dotenv').config();

module.exports = function(dir) {
    const entryPath = process.env.DIR_ENTRY_EDITORJS;
    let removeExcessObj = {};
    let ext = process.env.EXT;

    for (key in dir) {
        let pathEntryFile = entryPath + key + '/index.js';
        let fileContent = fs.readFileSync(pathEntryFile, "utf8");

        if(fileContent.indexOf('js') === -1)
        {
            let excessJsFile = {
                'dir' : process.env.DIR_OUTPUT_EDITORJS + key + '/js/',
                'file': process.env.DIR_OUTPUT_EDITORJS + key + '/js/' + key + ext
            };
            BundleObj(removeExcessObj, key, excessJsFile);
        }
    }

    fs.readFile('./removeExcessFile.json', 'utf8', function readFileCallback(err, data) {
        if (err) {
            console.log(err);
        } else {
            json = JSON.stringify(removeExcessObj);
            fs.writeFile('./removeExcessFile.json', json, 'utf8', () => {console.log('excess is writed')});
        }
    });
}
