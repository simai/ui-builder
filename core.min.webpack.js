// core.min.webpack.js

require('dotenv').config();

const path = require('path');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const pathConfig = require('./libs/formStructureCore');
const TerserPlugin = require("terser-webpack-plugin");
const webpack = require('webpack');
const { createPostcssOptions } = require('./libs/postcssPolicy');


new webpack.ProvidePlugin({
    SF : 'SF',
});


module.exports = {
    mode : 'production',
    cache: {
        type: 'filesystem',
        compression: 'brotli',
    },
    watch: true,
    watchOptions:
    {
        aggregateTimeout: 600,
        stdin: true,
        ignored:
        [
            '/node_modules/',
            '/distr/',
            '/.git/',
            '/libs/',
        ],
    },
    resolve: {
        extensions: ['.js', '.scss'],
    },
    experiments :
    {
        asset: true
    },
    devtool: false,
    entry : {
        'core': './src/core/index.js'
    },
    output :
    {
        pathinfo : false,
        path : path.resolve(__dirname, './distr'),
        publicPath : '/',
        filename : (pathData) => {
            return `core/js/core.min.js`;
        },
        assetModuleFilename : 'source/[ext]/[hash][ext][query]',
    },
    optimization :
    {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                test: /\.js(\?.*)?$/i,
                minify: TerserPlugin.uglifyJsMinify,
                terserOptions: {},
            }),
        ],
    },
    target:'web',
    module :
    {
        rules :
        [
            {
                test : /\.js$/,
                exclude : /node_modules/,
                use : ['babel-loader'],
                issuer: /\.css$/,
            },
            {
                test : /\.(scss|css)$/,
                use:
                [
                    {
                        loader : MiniCssExtractPlugin.loader,
                        options :
                        {
                            publicPath : path.join(__dirname, process.env.DIR_OUTPUT),
                        },
                    },
                    'css-loader',
                    {
                        loader: "postcss-loader",
                        options:
                        {
                            postcssOptions: createPostcssOptions({
                                browsers: 'last 4 versions',
                                autoprefixer: { position: true },
                            }),
                        }
                    },
                    'sass-loader',
                    {
                        loader : 'sass-resources-loader',
                        options :
                        {
                            resources :
                            [
                                process.env.DIR_CORE_MIXINS,
                                process.env.DIR_CORE_SF_VARIABLES,
                                process.env.DIR_CORE_SF_MIXINS,
                            ],
                            sourceMap: true,
                        }
                    }
                ],
            },
        ]
    },
    plugins:[
        new MiniCssExtractPlugin(
            {
                filename: (pathData) => {
                    return `core/css/core.min.css`;
                }
            }
        ),
    ]
}
