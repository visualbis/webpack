"use strict";

const {
	sources: { RawSource, OriginalSource, ReplaceSource },
	Compilation,
	util: { createHash },
	optimize: { RealContentHashPlugin }
} = require("../../../../");

/** @typedef {import("../../../../").Compiler} Compiler */
/** @typedef {import("../../../../").Asset} Asset */
/** @typedef {import("../../../../").AssetInfo} AssetInfo */
/** @typedef {import("../../../../").ChunkGroup} Entrypoint */

class VerifyAdditionalAssetsPlugin {
	/**
	 * @param {number} stage stage
	 */
	constructor(stage) {
		this.stage = stage;
	}

	/**
	 * @param {Compiler} compiler compiler
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap(
			"VerifyAdditionalAssetsPlugin",
			(compilation) => {
				const alreadySeenAssets = new Set();
				compilation.hooks.processAssets.tap(
					{
						name: "VerifyAdditionalAssetsPlugin",
						stage: this.stage,
						additionalAssets: true
					},
					(assets) => {
						for (const asset of Object.keys(assets)) {
							expect(alreadySeenAssets).not.toContain(asset);
							alreadySeenAssets.add(asset);
						}
					}
				);
			}
		);
	}
}

class HtmlPlugin {
	/**
	 * @param {string[]} entrypoints entrypoints
	 */
	constructor(entrypoints) {
		this.entrypoints = entrypoints;
	}

	/**
	 * @param {Compiler} compiler compiler
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap("html-plugin", (compilation) => {
			compilation.hooks.processAssets.tap(
				{
					name: "html-plugin",
					stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
				},
				() => {
					const publicPath = compilation.outputOptions.publicPath;
					const files = [];
					for (const name of this.entrypoints) {
						for (const file of /** @type {Entrypoint} */ (
							compilation.entrypoints.get(name)
						).getFiles()) {
							files.push(file);
						}
					}
					/**
					 * @param {string} file file
					 * @returns {string} content of script tag
					 */
					const toScriptTag = (file) => {
						const asset = /** @type {Asset} */ (compilation.getAsset(file));
						const hash = createHash("sha512");
						hash.update(asset.source.source());
						const integrity = `sha512-${hash.digest("base64")}`;
						compilation.updateAsset(
							file,
							(x) => x,
							/**
							 * @param {AssetInfo} assetInfo asset info
							 * @returns {AssetInfo} new asset info
							 */
							(assetInfo) => ({
								...assetInfo,
								contenthash: Array.isArray(assetInfo.contenthash)
									? [...new Set([...assetInfo.contenthash, integrity])]
									: assetInfo.contenthash
										? [assetInfo.contenthash, integrity]
										: integrity
							})
						);
						return `<script src="${
							publicPath === "auto" ? "" : publicPath
						}${file}" integrity="${integrity}"></script>`;
					};
					compilation.emitAsset(
						"index.html",
						new OriginalSource(
							`<html>
	<body>
${files.map((file) => `		${toScriptTag(file)}`).join("\n")}
	</body>
</html>`,
							"index.html"
						)
					);
				}
			);
		});
	}
}

class HtmlInlinePlugin {
	/**
	 * @param {RegExp} inline inline
	 */
	constructor(inline) {
		this.inline = inline;
	}

	/**
	 * @param {Compiler} compiler compiler
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap("html-inline-plugin", (compilation) => {
			compilation.hooks.processAssets.tap(
				{
					name: "html-inline-plugin",
					stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE,
					additionalAssets: true
				},
				(assets) => {
					const publicPath =
						/** @type {string} */
						(compilation.outputOptions.publicPath);
					for (const name of Object.keys(assets)) {
						if (/\.html$/.test(name)) {
							const asset = /** @type {Asset} */ (compilation.getAsset(name));
							const content = /** @type {string} */ (asset.source.source());
							/** @type {{ start: number, length: number, asset: Asset }[]} */
							const matches = [];
							const regExp =
								/<script\s+src\s*=\s*"([^"]+)"(?:\s+[^"=\s]+(?:\s*=\s*(?:"[^"]*"|[^\s]+))?)*\s*><\/script>/g;
							let match = regExp.exec(content);
							while (match) {
								let url = match[1];
								if (url.startsWith(publicPath)) {
									url = url.slice(publicPath.length);
								}
								if (this.inline.test(url)) {
									const asset = /** @type {Asset} */ (
										compilation.getAsset(url)
									);
									matches.push({
										start: match.index,
										length: match[0].length,
										asset
									});
								}
								match = regExp.exec(content);
							}
							if (matches.length > 0) {
								const newSource = new ReplaceSource(asset.source, name);
								for (const { start, length, asset } of matches) {
									newSource.replace(
										start,
										start + length - 1,
										`<script>${asset.source.source()}</script>`
									);
								}
								compilation.updateAsset(name, newSource);
							}
						}
					}
				}
			);
		});
	}
}

class SriHashSupportPlugin {
	/**
	 * @param {Compiler} compiler compiler
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap("sri-hash-support-plugin", (compilation) => {
			RealContentHashPlugin.getCompilationHooks(compilation).updateHash.tap(
				"sri-hash-support-plugin",
				(input, oldHash) => {
					if (/^sha512-.{88}$/.test(oldHash) && input.length === 1) {
						const hash = createHash("sha512");
						hash.update(input[0]);
						return `sha512-${hash.digest("base64")}`;
					}
				}
			);
		});
	}
}

class HtmlMinimizePlugin {
	/**
	 * @param {Compiler} compiler compiler
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap("html-minimize-plugin", (compilation) => {
			compilation.hooks.processAssets.tap(
				{
					name: "html-minimize-plugin",
					stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE,
					additionalAssets: true
				},
				(assets) => {
					for (const name of Object.keys(assets)) {
						if (/\.html$/.test(name)) {
							compilation.updateAsset(
								name,
								(source) =>
									new RawSource(
										/** @type {string} */
										(source.source()).replace(/\s+/g, " ")
									),
								(assetInfo) => ({
									...assetInfo,
									minimized: true
								})
							);
						}
					}
				}
			);
		});
	}
}

/** @type {import("../../../../").Configuration} */
module.exports = {
	mode: "production",
	entry: {
		test: { import: "./index.js", filename: "test.js" },
		inline: "./inline.js",
		normal: "./normal.js"
	},
	output: {
		filename: "[name]-[contenthash].js"
	},
	optimization: {
		minimize: true,
		minimizer: ["...", new HtmlMinimizePlugin()]
	},
	node: {
		__dirname: false,
		__filename: false
	},
	plugins: [
		new VerifyAdditionalAssetsPlugin(
			Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL - 1
		),
		// new VerifyAdditionalAssetsPlugin(Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE),
		// new VerifyAdditionalAssetsPlugin(Compilation.PROCESS_ASSETS_STAGE_REPORT),
		new HtmlPlugin(["inline", "normal"]),
		new HtmlInlinePlugin(/inline/),
		new SriHashSupportPlugin()
	]
};
