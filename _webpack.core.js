// webpack.config.js

require('dotenv').config();

const path                      = require('path');
const MiniCssExtractPlugin      = require("mini-css-extract-plugin");
const { CleanWebpackPlugin }    = require('clean-webpack-plugin');
const { createPostcssOptions }  = require('./libs/postcssPolicy');

module.exports = {
    mode : 'development',
    resolve: {
        extensions: ['.js', '.scss']
    },
    devtool: false,
    entry :
    {
        core: path.resolve(__dirname, process.env.DIR_ENTRY_CORE)
    },
    output :
    {
        pathinfo : false,
        path : path.resolve(__dirname, process.env.DIR_OUTPUT),
        filename : 'core/js/[name].js',
    },
    module :
    {
        rules :
        [
            {
                test : /\.js$/,
                exclude : /node_modules/,
                use : ['babel-loader'],
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
                filename: "core/css/[name].css",
                chunkFilename: 'core/css/[id].css'
            }
        ),
        new CleanWebpackPlugin(
            {
                cleanOnceBeforeBuildPatterns: [
                    path.resolve(__dirname, process.env.DIR_OUTPUT + '[name]/css/[name].css')
                ],
            }
        ),
    ]
}
