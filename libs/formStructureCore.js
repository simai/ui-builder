// formStructureCore.js

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const entryPath = process.env.DIR_ENTRY_UTILITY;
const entryPathComponent = process.env.DIR_ENTRY_COMPONENT;

function getFiles (dir, returnPath = '', files_ = false,mod='utility')
{
    files_ = files_ || [];
    let files = fs.readdirSync(dir);

    for (let i in files)
    {
        var name = dir + '/' + files[i];
        let name2 = ``;

        if(files[i] != 'scss')
        {
            name2 = `${returnPath}/${files[i]}`;
        }
        else
        {
            name2 = `${returnPath}`;
        }

        if (fs.statSync(name).isDirectory())
        {
            getFiles(name, name2, files_);
        }
        else if(files[i] == 'rule.js') //if(path.extname(files[i]) == '.js')
        {
            files_[name2] = `../../${mod}${name2}`;
            break;
        }
    }
    return files_;
}

/**
 *
 * @string {*} path
 * @array {*} exception
 *
 * Returns an object with found directories and subdirectories
 */
const SearchDirCore = (dir, exc,mod='utility') => {
    var arrDir = [];
    var arrFileName = [];

    var arrFileName = fs.readdirSync(dir).map(filename => {
        return filename;
    });

    var arrDir = arrFileName.filter(
        filename =>
        {
            file = path.resolve(dir, filename);
            stat = fs.statSync(file).isDirectory();

            if(stat && exc.indexOf(filename) === -1)
            {
                return file;
            }
        }
    );

    var subdir;
    var objDir = {};

    arrDir.forEach(
        (dirName, i) =>
        {
            subdir = path.resolve(dir, dirName);
            getFiles(subdir,`/${dirName}`,objDir,mod);
        }
    );

    return objDir;
}

let filePathDir = SearchDirCore(entryPath, ['core, package','editorjs'],'utility');
let filePathComp = SearchDirCore(entryPathComponent, ['core, package','editorjs'],'component');
let strPath = '';

for(let k in filePathDir)
{
    strPath += `import '${filePathDir[k]}';\n`;
}

for(let k in filePathComp)
{
    strPath += `import '${filePathComp[k]}';\n`;
}


fs.writeFileSync("./src/core/js/rulesrc.js", strPath);

module.exports = filePathDir;