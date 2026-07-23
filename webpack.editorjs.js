// webpack.editorjs.js

require('dotenv').config();

const path                      = require('path');
const MiniCssExtractPlugin      = require("mini-css-extract-plugin");
const { CleanWebpackPlugin }    = require('clean-webpack-plugin');
const pathConfig                = require('./libs/editorjsGeneratePath');
const { createPostcssOptions }  = require('./libs/postcssPolicy');

module.exports = {
    mode : 'development',
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
    entry : pathConfig,
    output :
    {
        pathinfo : false,
        path : path.resolve(__dirname, 'distr'),
        publicPath : '/',
        filename : 'editorjs/[name]/js/[name].js',
        library: 'Checklist',
        libraryTarget: 'umd',
        libraryExport: 'default',
    },
    optimization :
    {
        minimize: false,
    },
    target:'web',
    module :
    {
        rules :
        [
            {
                test : /\.js$/,
                exclude : /node_modules/,
                use : [
                    {
                        loader: 'babel-loader',
                    }
                ]
            },
            {
                test : /\.(scss|css)$/,
                use:
                [
                    {
                        loader : MiniCssExtractPlugin.loader,
                        options :
                        {
                            publicPath : '../../.././',
                        },
                    },
                    'css-loader',
                    {
                        loader: "postcss-loader",
                        options:
                        {
                            postcssOptions: createPostcssOptions({
                                browsers: 'last 2 versions',
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
                                process.env.DIR_GLOBAL_MIXINS,
                                process.env.DIR_GLOBAL_VARIABLES,
                                process.env.DIR_GLOBAL_SF_VARIABLES,
                                process.env.DIR_GLOBAL_SF_MIXINS,
                                process.env.DIR_GLOBAL_EXT,
                                process.env.DIR_GLOBAL_SF_EXT,
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
                filename: "editorjs/[name]/css/[name].css",
            }
        ),
        new CleanWebpackPlugin(
            {
                cleanOnceBeforeBuildPatterns: [
                    path.resolve(__dirname, process.env.DIR_OUTPUT_EDITORJS + '[name]/css/[name].css')
                ],
            }
        ),
    ]
}
