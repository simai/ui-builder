// postcss.config.js

const {
    createPostcssPresetEnvOptions,
} = require("./libs/postcssPolicy");

module.exports = {
    plugins: {
        'postcss-preset-env': createPostcssPresetEnvOptions({
            browsers: 'last 4 versions',
            autoprefixer: { position: true }
        }),
    },
};
