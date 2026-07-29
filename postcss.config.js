// postcss.config.js

const {
    createPostcssPlugins,
} = require("./libs/postcssPolicy");

module.exports = {
    plugins: createPostcssPlugins({
            browsers: 'last 4 versions',
            autoprefixer: { position: true }
        }),
};
