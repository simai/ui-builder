// formStructure.js

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const entryPath = process.env.DIR_ENTRY_UTILITY;

function getFiles (dir, returnPath = '', files_ = false)
{
    files_ = files_ || [];
    let files = fs.readdirSync(dir);

    for (let i in files)
    {
        var name = dir + '/' + files[i];
        let name2 = ``;

        if(fs.statSync(name).isDirectory() && files[i] != 'scss' && files[i] != 'js')
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
        else
        {
            let scss = false;

            for (let k in files)
            {
                if(files[k] == 'index.scss')
                {
                    scss = true;
                }
            }

            if(scss)
            {
                files_[name2] = `${entryPath}${name2}/index.scss`;
            }
            else
            {
                files_[name2] = `${entryPath}${name2}/index.js`;
            }

            scss = false;

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
const SearchDir = (dir, exc) => {
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
            getFiles(subdir,`/${dirName}`,objDir);
        }
    );

    return objDir;
}

module.exports = SearchDir(entryPath, ['core, package','editorjs']);