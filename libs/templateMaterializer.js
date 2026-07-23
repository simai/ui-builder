"use strict";

const fs = require("node:fs");
const path = require("node:path");

function materializeTemplates(templateCopies)
{
    for (const template of templateCopies)
    {
        fs.mkdirSync(path.dirname(template.destination), { recursive: true });
        fs.copyFileSync(template.source, template.destination);
    }
}

module.exports = {
    materializeTemplates,
};
