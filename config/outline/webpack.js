// webpack.modal.config.js

require('dotenv').config();

const path                      = require('path');
const MiniCssExtractPlugin      = require("mini-css-extract-plugin");
const { CleanWebpackPlugin }    = require('clean-webpack-plugin');


module.exports = {
    mode : 'development',
    resolve: {
        extensions: ['.js', '.scss']
    },
    devtool: false,
    entry :
    {
        core: path.resolve(__dirname, process.env.DIR_ENTRY_OUTLINE)
    },
    output :
    {
        pathinfo : false,
        path : path.resolve(__dirname, process.env.DIR_OUTPUT_OUTLINE),
        filename : 'outline/js/outline.js',
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
                            publicPath : path.join(__dirname, process.env.DIR_OUTPUT_OUTLINE),
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
                filename: "outline/css/outline.css",
                chunkFilename: 'outline/css/[id].css'
            }
        ),
        new CleanWebpackPlugin(
            {
                cleanOnceBeforeBuildPatterns: [
                    path.resolve(__dirname, process.env.DIR_OUTPUT_PLUGIN + 'outline/css/outline.css')
                ],
            }
        ),
    ]
}