/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { compareChunksNatural } = require("../util/comparators");
const {
	assignAscendingChunkIds,
	assignNames,
	getLongChunkName,
	getShortChunkName,
	getUsedChunkIds
} = require("./IdHelpers");

/** @typedef {import("../../declarations/WebpackOptions").OutputNormalized} Output */
/** @typedef {import("../Chunk")} Chunk */
/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../Module")} Module */

/**
 * @typedef {object} NamedChunkIdsPluginOptions
 * @property {string=} context context
 * @property {string=} delimiter delimiter
 */

const PLUGIN_NAME = "NamedChunkIdsPlugin";

class NamedChunkIdsPlugin {
	/**
	 * @param {NamedChunkIdsPluginOptions=} options options
	 */
	constructor(options) {
		this.delimiter = (options && options.delimiter) || "-";
		this.context = options && options.context;
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
			const hashFunction =
				/** @type {NonNullable<Output["hashFunction"]>} */
				(compilation.outputOptions.hashFunction);
			compilation.hooks.chunkIds.tap(PLUGIN_NAME, (chunks) => {
				const chunkGraph = compilation.chunkGraph;
				const context = this.context ? this.context : compiler.context;
				const delimiter = this.delimiter;

				const unnamedChunks = assignNames(
					[...chunks].filter((chunk) => {
						if (chunk.name) {
							chunk.id = chunk.name;
							chunk.ids = [chunk.name];
						}
						return chunk.id === null;
					}),
					(chunk) =>
						getShortChunkName(
							chunk,
							chunkGraph,
							context,
							delimiter,
							hashFunction,
							compiler.root
						),
					(chunk) =>
						getLongChunkName(
							chunk,
							chunkGraph,
							context,
							delimiter,
							hashFunction,
							compiler.root
						),
					compareChunksNatural(chunkGraph),
					getUsedChunkIds(compilation),
					(chunk, name) => {
						chunk.id = name;
						chunk.ids = [name];
					}
				);
				if (unnamedChunks.length > 0) {
					assignAscendingChunkIds(unnamedChunks, compilation);
				}
			});
		});
	}
}

module.exports = NamedChunkIdsPlugin;
