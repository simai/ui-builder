const core = require("./core.webpack");
const coreMin = require("./core.min.webpack");
const component = require("./component.webpack");
const componentMin = require("./component.min.webpack");
const utility = require("./utility.webpack");
const utilityMin = require("./utility.min.webpack");

module.exports = [
    core,
    component,
    utility,
    coreMin,
    componentMin,
    utilityMin,
];
