module.exports = function bundleObj(obj, prop, value)
{
    Object.defineProperty(obj, prop, {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true
    });
}