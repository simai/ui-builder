// webpack.modal.config.js

require('dotenv').config();

const path                      = require('path');
const MiniCssExtractPlugin      = require("mini-css-extract-plugin");
const { CleanWebpackPlugin }    = require('clean-webpack-plugin');

let outputDivider = "../../distr/plugin/";
let entryDivider = "../../src/plugin/divider/index.js";


module.exports = {
    mode : 'development',
    resolve: {
        extensions: ['.js', '.scss']
    },
    devtool: false,
    entry :
    {
        core: path.resolve(__dirname, entryDivider)
    },
    output :
    {
        pathinfo : false,
        path : path.resolve(__dirname, outputDivider),
        filename : 'divider/js/divider.js',
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
                            publicPath : path.join(__dirname, outputDivider),
                        },
                    },
                    'css-loader',
                    {
                        loader: "postcss-loader",
                        options:
                        {
                            postcssOptions:
                            {
                                plugins:
                                [
                                ],
                            },
                        }
                    },
                    'sass-loader',
                ],
            },
        ]
    },
    plugins:[
        new MiniCssExtractPlugin(
            {
                filename: "divider/css/divider.css",
                chunkFilename: 'divider/css/[id].css'
            }
        ),
        new CleanWebpackPlugin(
            {
                cleanOnceBeforeBuildPatterns: [
                    path.resolve(__dirname, `${outputDivider}outline/css/outline.css`)
                ],
            }
        ),
    ]
}