/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { ConcatSource } = require("webpack-sources");
const RuntimeGlobals = require("../RuntimeGlobals");
const Template = require("../Template");
const JavascriptModulesPlugin = require("../javascript/JavascriptModulesPlugin");
const ConcatenatedModule = require("../optimize/ConcatenatedModule");
const propertyAccess = require("../util/propertyAccess");
const AbstractLibraryPlugin = require("./AbstractLibraryPlugin");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../../declarations/WebpackOptions").LibraryOptions} LibraryOptions */
/** @typedef {import("../../declarations/WebpackOptions").LibraryType} LibraryType */
/** @typedef {import("../Chunk")} Chunk */
/** @typedef {import("../Compilation").ChunkHashContext} ChunkHashContext */
/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../Module")} Module */
/** @typedef {import("../Module").BuildMeta} BuildMeta */
/** @typedef {import("../javascript/JavascriptModulesPlugin").StartupRenderContext} StartupRenderContext */
/** @typedef {import("../util/Hash")} Hash */

/**
 * @template T
 * @typedef {import("./AbstractLibraryPlugin").LibraryContext<T>} LibraryContext<T>
 */

/**
 * @typedef {object} ModuleLibraryPluginOptions
 * @property {LibraryType} type
 */

/**
 * @typedef {object} ModuleLibraryPluginParsed
 * @property {string} name
 * @property {string | string[]=} export
 */

const PLUGIN_NAME = "ModuleLibraryPlugin";

/**
 * @typedef {ModuleLibraryPluginParsed} T
 * @extends {AbstractLibraryPlugin<ModuleLibraryPluginParsed>}
 */
class ModuleLibraryPlugin extends AbstractLibraryPlugin {
	/**
	 * @param {ModuleLibraryPluginOptions} options the plugin options
	 */
	constructor(options) {
		super({
			pluginName: "ModuleLibraryPlugin",
			type: options.type
		});
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		super.apply(compiler);

		compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
			const { exportsDefinitions } =
				ConcatenatedModule.getCompilationHooks(compilation);
			exportsDefinitions.tap(PLUGIN_NAME, (definitions, module) => {
				const bailout = JavascriptModulesPlugin.getCompilationHooks(
					compilation
				).inlineInRuntimeBailout.call(module, {});
				if (bailout) return false;
				// If we have connections not all modules were concatenated, so we need the wrapper
				const connections =
					compilation.moduleGraph.getIncomingConnections(module);

				for (const connection of connections) {
					if (connection.originModule) {
						return false;
					}
				}

				// Runtime and splitting chunks now requires the wrapper too
				for (const chunk of compilation.chunkGraph.getModuleChunksIterable(
					module
				)) {
					if (
						!chunk.hasRuntime() ||
						compilation.chunkGraph.getNumberOfEntryModules(chunk) > 1
					) {
						return false;
					}
				}

				return true;
			});
		});
	}

	/**
	 * @param {LibraryOptions} library normalized library option
	 * @returns {T | false} preprocess as needed by overriding
	 */
	parseOptions(library) {
		const { name } = library;
		if (name) {
			throw new Error(
				`Library name must be unset. ${AbstractLibraryPlugin.COMMON_LIBRARY_NAME_MESSAGE}`
			);
		}
		const _name = /** @type {string} */ (name);
		return {
			name: _name,
			export: library.export
		};
	}

	/**
	 * @param {Source} source source
	 * @param {Module} module module
	 * @param {StartupRenderContext} renderContext render context
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {Source} source with library export
	 */
	renderStartup(
		source,
		module,
		{ moduleGraph, chunk, codeGenerationResults },
		{ options, compilation }
	) {
		const result = new ConcatSource(source);
		const exportsInfo = options.export
			? [
					moduleGraph.getExportInfo(
						module,
						Array.isArray(options.export) ? options.export[0] : options.export
					)
				]
			: moduleGraph.getExportsInfo(module).orderedExports;
		const definitions =
			/** @type {BuildMeta} */
			(module.buildMeta).exportsFinalName || {};
		/** @type {string[]} */
		const shortHandedExports = [];
		/** @type {[string, string][]} */
		const exports = [];
		const isAsync = moduleGraph.isAsync(module);

		if (isAsync) {
			result.add(
				`${RuntimeGlobals.exports} = await ${RuntimeGlobals.exports};\n`
			);
		}

		const varType = compilation.outputOptions.environment.const
			? "const"
			: "var";

		for (const exportInfo of exportsInfo) {
			if (!exportInfo.provided) continue;

			let shouldContinue = false;

			const reexport = exportInfo.findTarget(moduleGraph, (_m) => true);

			if (reexport) {
				const exp = moduleGraph.getExportsInfo(reexport.module);

				for (const reexportInfo of exp.orderedExports) {
					if (
						reexportInfo.provided === false &&
						reexportInfo.name !== "default" &&
						reexportInfo.name === /** @type {string[]} */ (reexport.export)[0]
					) {
						shouldContinue = true;
					}
				}
			}

			if (shouldContinue) continue;

			const originalName = exportInfo.name;
			const usedName =
				/** @type {string} */
				(exportInfo.getUsedName(originalName, chunk.runtime));
			/** @type {string | undefined} */
			const definition = definitions[usedName];
			const finalName =
				definition ||
				`${RuntimeGlobals.exports}${Template.toIdentifier(originalName)}`;

			if (!definition) {
				result.add(
					`${varType} ${finalName} = ${RuntimeGlobals.exports}${propertyAccess([
						usedName
					])};\n`
				);
			}

			if (
				finalName &&
				(finalName.includes(".") ||
					finalName.includes("[") ||
					finalName.includes("("))
			) {
				if (exportInfo.isReexport()) {
					const { data } = codeGenerationResults.get(module, chunk.runtime);
					const topLevelDeclarations =
						(data && data.get("topLevelDeclarations")) ||
						(module.buildInfo && module.buildInfo.topLevelDeclarations);

					if (topLevelDeclarations && topLevelDeclarations.has(originalName)) {
						const name = `${RuntimeGlobals.exports}${Template.toIdentifier(originalName)}`;
						result.add(`${varType} ${name} = ${finalName};\n`);
						shortHandedExports.push(`${name} as ${originalName}`);
					} else {
						exports.push([originalName, finalName]);
					}
				} else {
					exports.push([originalName, finalName]);
				}
			} else {
				shortHandedExports.push(
					definition && finalName === originalName
						? finalName
						: `${finalName} as ${originalName}`
				);
			}
		}

		if (shortHandedExports.length > 0) {
			result.add(`export { ${shortHandedExports.join(", ")} };\n`);
		}

		for (const [exportName, final] of exports) {
			result.add(`export ${varType} ${exportName} = ${final};\n`);
		}

		return result;
	}
}

module.exports = ModuleLibraryPlugin;
