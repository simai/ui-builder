// component.min.webpack.js

require('dotenv').config();

const path = require('path');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const pathConfig = require('./libs/formStructureComponent');
const webpack                   = require('webpack');
const { createPostcssOptions }  = require('./libs/postcssPolicy');

new webpack.ProvidePlugin({
    hljs : 'hljs',
    ClipboardJS : 'ClipboardJS',
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
    optimization :
    {
        minimize: true,
        minimizer:
        [
            new TerserPlugin({
                test: /\.js(\?.*)?$/i,
                minify: TerserPlugin.uglifyJsMinify,
                terserOptions: {},
            }),
        ],
    },
    devtool: false,
    entry : pathConfig,
    output :
    {
        pathinfo : false,
        path : path.resolve(__dirname, 'distr'),
        publicPath : '/',
        filename : (pathData) => {
            return `component[name]/js/${pathData.chunk.name.split('/')[pathData.chunk.name.split('/').length-1]}.min.js`;
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
                    return `component[name]/css/${pathData.chunk.name.split('/')[pathData.chunk.name.split('/').length-1]}.min.css`;
                }
            }
        ),
    ]
}
