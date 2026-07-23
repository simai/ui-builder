// utility.webpack.js

require('dotenv').config();

const path = require('path');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const pathConfig = require('./libs/formStructureUtility');
const webpack = require('webpack');
const RemoveEmptyScriptsPlugin = require('webpack-remove-empty-scripts');
const { createPostcssOptions } = require('./libs/postcssPolicy');

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
        extensions: ['.scss','.js'],
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
        filename : (pathData) => {
            let filename = pathData.chunk.name.split('/')[pathData.chunk.name.split('/').length-1];
            return `utility[name]/js/${filename}.js`;
        },
        assetModuleFilename : 'source/[ext]/[hash][ext][query]',
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
                            publicPath : '../../.././',
                        },
                    },
                    'css-loader',
                    {
                        loader: "postcss-loader",
                        options:
                        {
                            postcssOptions: createPostcssOptions({
                                browsers: 'last 1 version, >1%',
                                autoprefixer: {
                                    position: true,
                                    backgroundColor:false,
                                    color:false,
                                    borderColor:false
                                },
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
                                path.resolve(__dirname,'./src/core/scss/_sf_var__color.scss'),
                                path.resolve(__dirname,'./src/core/scss/_sf_var__breakpoint.scss'),
                                path.resolve(__dirname,'./src/core/scss/_sf_var__size.scss'),
                                path.resolve(__dirname,'./src/core/scss/_sf_var__space.scss'),
                                path.resolve(__dirname,'./src/core/scss/_sf_mix__breakpoint.scss'),
                                path.resolve(__dirname,'./src/core/scss/_mix__breakpoint.scss'),
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
                    let filename = pathData.chunk.name.split('/')[pathData.chunk.name.split('/').length-1];
                    return `utility[name]/css/${filename}.css`;
                }
            }
        ),
        new RemoveEmptyScriptsPlugin(),
        new CleanWebpackPlugin(
            {
                cleanOnceBeforeBuildPatterns: [
                    path.resolve(__dirname, process.env.DIR_ENTRY_UTILITY + '/[name]/css/index.css')
                ],
            }
        ),
    ]
}
