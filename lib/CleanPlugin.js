/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Sergey Melyukov @smelukov
*/

"use strict";

const path = require("path");
const asyncLib = require("neo-async");
const { SyncBailHook } = require("tapable");
const Compilation = require("./Compilation");
const createSchemaValidation = require("./util/create-schema-validation");
const { join } = require("./util/fs");
const processAsyncTree = require("./util/processAsyncTree");

/** @typedef {import("../declarations/WebpackOptions").CleanOptions} CleanOptions */
/** @typedef {import("./Compiler")} Compiler */
/** @typedef {import("./logging/Logger").Logger} Logger */
/** @typedef {import("./util/fs").IStats} IStats */
/** @typedef {import("./util/fs").OutputFileSystem} OutputFileSystem */
/** @typedef {import("./util/fs").StatsCallback} StatsCallback */

/** @typedef {Map<string, number>} Assets */

/**
 * @typedef {object} CleanPluginCompilationHooks
 * @property {SyncBailHook<[string], boolean | void>} keep when returning true the file/directory will be kept during cleaning, returning false will clean it and ignore the following plugins and config
 */

/**
 * @callback KeepFn
 * @param {string} path path
 * @returns {boolean | void} true, if the path should be kept
 */

const validate = createSchemaValidation(
	undefined,
	() => {
		const { definitions } = require("../schemas/WebpackOptions.json");

		return {
			definitions,
			oneOf: [{ $ref: "#/definitions/CleanOptions" }]
		};
	},
	{
		name: "Clean Plugin",
		baseDataPath: "options"
	}
);
const _10sec = 10 * 1000;

/**
 * merge assets map 2 into map 1
 * @param {Assets} as1 assets
 * @param {Assets} as2 assets
 * @returns {void}
 */
const mergeAssets = (as1, as2) => {
	for (const [key, value1] of as2) {
		const value2 = as1.get(key);
		if (!value2 || value1 > value2) as1.set(key, value1);
	}
};

/**
 * @param {Map<string, number>} assets current assets
 * @returns {Set<string>} Set of directory paths
 */
function getDirectories(assets) {
	const directories = new Set();
	/**
	 * @param {string} filename asset filename
	 */
	const addDirectory = (filename) => {
		directories.add(path.dirname(filename));
	};

	// get directories of assets
	for (const [asset] of assets) {
		addDirectory(asset);
	}
	// and all parent directories
	for (const directory of directories) {
		addDirectory(directory);
	}
	return directories;
}

/**
 * @param {string} a First directory path to compare
 * @param {string} b Second directory path to compare
 * @returns {boolean} True if both paths have the same parent directory
 */
function isEqualPath(a, b) {
	return path.normalize(a) === path.normalize(b);
}

/**
 * @param {Map<string, number>|Set<string>} files Collection of files to check against
 * @param {string} file File path to check
 * @returns {boolean} True if the file or its parent exists in the collection
 */
function hasFile(files, file) {
	if (files instanceof Set) {
		for (const dir of files) {
			if (isEqualPath(dir, file)) {
				return true;
			}
		}
	}
	if (files instanceof Map) {
		for (const dir of files.keys()) {
			if (isEqualPath(dir, file)) {
				return true;
			}
		}
	}
	return false;
}

/** @typedef {Set<string>} Diff */

/**
 * @param {OutputFileSystem} fs filesystem
 * @param {string} outputPath output path
 * @param {Map<string, number>} currentAssets filename of the current assets (must not start with .. or ., must only use / as path separator)
 * @param {(err?: Error | null, set?: Diff) => void} callback returns the filenames of the assets that shouldn't be there
 * @returns {void}
 */
const getDiffToFs = (fs, outputPath, currentAssets, callback) => {
	const directories = getDirectories(currentAssets);
	const diff = new Set();
	asyncLib.forEachLimit(
		directories,
		10,
		(directory, callback) => {
			/** @type {NonNullable<OutputFileSystem["readdir"]>} */
			(fs.readdir)(join(fs, outputPath, directory), (err, entries) => {
				if (err) {
					if (err.code === "ENOENT") return callback();
					if (err.code === "ENOTDIR") {
						diff.add(directory);
						return callback();
					}
					return callback(err);
				}
				for (const entry of /** @type {string[]} */ (entries)) {
					const file = entry;
					const filename = directory ? `${directory}/${file}` : file;
					if (
						!hasFile(directories, filename) &&
						!hasFile(currentAssets, filename)
					) {
						diff.add(filename);
					}
				}
				callback();
			});
		},
		(err) => {
			if (err) return callback(err);

			callback(null, diff);
		}
	);
};

/**
 * @param {Assets} currentAssets assets list
 * @param {Assets} oldAssets old assets list
 * @returns {Diff} diff
 */
const getDiffToOldAssets = (currentAssets, oldAssets) => {
	const diff = new Set();
	const now = Date.now();
	for (const [asset, ts] of oldAssets) {
		if (ts >= now) continue;
		if (!currentAssets.has(asset)) diff.add(asset);
	}
	return diff;
};

/**
 * @param {OutputFileSystem} fs filesystem
 * @param {string} filename path to file
 * @param {StatsCallback} callback callback for provided filename
 * @returns {void}
 */
const doStat = (fs, filename, callback) => {
	if ("lstat" in fs) {
		/** @type {NonNullable<OutputFileSystem["lstat"]>} */
		(fs.lstat)(filename, callback);
	} else {
		fs.stat(filename, callback);
	}
};

/**
 * @param {OutputFileSystem} fs filesystem
 * @param {string} outputPath output path
 * @param {boolean} dry only log instead of fs modification
 * @param {Logger} logger logger
 * @param {Diff} diff filenames of the assets that shouldn't be there
 * @param {(path: string) => boolean | void} isKept check if the entry is ignored
 * @param {(err?: Error, assets?: Assets) => void} callback callback
 * @returns {void}
 */
const applyDiff = (fs, outputPath, dry, logger, diff, isKept, callback) => {
	/**
	 * @param {string} msg message
	 */
	const log = (msg) => {
		if (dry) {
			logger.info(msg);
		} else {
			logger.log(msg);
		}
	};
	/** @typedef {{ type: "check" | "unlink" | "rmdir", filename: string, parent: { remaining: number, job: Job } | undefined }} Job */
	/** @type {Job[]} */
	const jobs = Array.from(diff.keys(), (filename) => ({
		type: "check",
		filename,
		parent: undefined
	}));
	/** @type {Assets} */
	const keptAssets = new Map();
	processAsyncTree(
		jobs,
		10,
		({ type, filename, parent }, push, callback) => {
			const path = join(fs, outputPath, filename);
			/**
			 * @param {Error & { code?: string }} err error
			 * @returns {void}
			 */
			const handleError = (err) => {
				const isAlreadyRemoved = () =>
					new Promise((resolve) => {
						if (err.code === "ENOENT") {
							resolve(true);
						} else if (err.code === "EPERM") {
							// https://github.com/isaacs/rimraf/blob/main/src/fix-eperm.ts#L37
							// fs.existsSync(path) === false https://github.com/webpack/webpack/actions/runs/15493412975/job/43624272783?pr=19586
							doStat(fs, path, (err) => {
								if (err) {
									resolve(err.code === "ENOENT");
								} else {
									resolve(false);
								}
							});
						} else {
							resolve(false);
						}
					});

				isAlreadyRemoved().then((isRemoved) => {
					if (isRemoved) {
						log(`${filename} was removed during cleaning by something else`);
						handleParent();
						return callback();
					}
					return callback(err);
				});
			};
			const handleParent = () => {
				if (parent && --parent.remaining === 0) push(parent.job);
			};
			switch (type) {
				case "check":
					if (isKept(filename)) {
						keptAssets.set(filename, 0);
						// do not decrement parent entry as we don't want to delete the parent
						log(`${filename} will be kept`);
						return process.nextTick(callback);
					}
					doStat(fs, path, (err, stats) => {
						if (err) return handleError(err);
						if (!(/** @type {IStats} */ (stats).isDirectory())) {
							push({
								type: "unlink",
								filename,
								parent
							});
							return callback();
						}

						/** @type {NonNullable<OutputFileSystem["readdir"]>} */
						(fs.readdir)(path, (err, _entries) => {
							if (err) return handleError(err);
							/** @type {Job} */
							const deleteJob = {
								type: "rmdir",
								filename,
								parent
							};
							const entries = /** @type {string[]} */ (_entries);
							if (entries.length === 0) {
								push(deleteJob);
							} else {
								const parentToken = {
									remaining: entries.length,
									job: deleteJob
								};
								for (const entry of entries) {
									const file = /** @type {string} */ (entry);
									if (file.startsWith(".")) {
										log(
											`${filename} will be kept (dot-files will never be removed)`
										);
										continue;
									}
									push({
										type: "check",
										filename: `${filename}/${file}`,
										parent: parentToken
									});
								}
							}
							return callback();
						});
					});
					break;
				case "rmdir":
					log(`${filename} will be removed`);
					if (dry) {
						handleParent();
						return process.nextTick(callback);
					}
					if (!fs.rmdir) {
						logger.warn(
							`${filename} can't be removed because output file system doesn't support removing directories (rmdir)`
						);
						return process.nextTick(callback);
					}
					fs.rmdir(path, (err) => {
						if (err) return handleError(err);
						handleParent();
						callback();
					});
					break;
				case "unlink":
					log(`${filename} will be removed`);
					if (dry) {
						handleParent();
						return process.nextTick(callback);
					}
					if (!fs.unlink) {
						logger.warn(
							`${filename} can't be removed because output file system doesn't support removing files (rmdir)`
						);
						return process.nextTick(callback);
					}
					fs.unlink(path, (err) => {
						if (err) return handleError(err);
						handleParent();
						callback();
					});
					break;
			}
		},
		(err) => {
			if (err) return callback(err);
			callback(undefined, keptAssets);
		}
	);
};

/** @type {WeakMap<Compilation, CleanPluginCompilationHooks>} */
const compilationHooksMap = new WeakMap();

const PLUGIN_NAME = "CleanPlugin";

class CleanPlugin {
	/**
	 * @param {Compilation} compilation the compilation
	 * @returns {CleanPluginCompilationHooks} the attached hooks
	 */
	static getCompilationHooks(compilation) {
		if (!(compilation instanceof Compilation)) {
			throw new TypeError(
				"The 'compilation' argument must be an instance of Compilation"
			);
		}
		let hooks = compilationHooksMap.get(compilation);
		if (hooks === undefined) {
			hooks = {
				keep: new SyncBailHook(["ignore"])
			};
			compilationHooksMap.set(compilation, hooks);
		}
		return hooks;
	}

	/** @param {CleanOptions} options options */
	constructor(options = {}) {
		validate(options);
		this.options = { dry: false, ...options };
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		const { dry, keep } = this.options;

		/** @type {KeepFn} */
		const keepFn =
			typeof keep === "function"
				? keep
				: typeof keep === "string"
					? (path) => path.startsWith(keep)
					: typeof keep === "object" && keep.test
						? (path) => keep.test(path)
						: () => false;

		// We assume that no external modification happens while the compiler is active
		// So we can store the old assets and only diff to them to avoid fs access on
		// incremental builds
		/** @type {undefined|Assets} */
		let oldAssets;

		compiler.hooks.emit.tapAsync(
			{
				name: PLUGIN_NAME,
				stage: 100
			},
			(compilation, callback) => {
				const hooks = CleanPlugin.getCompilationHooks(compilation);
				const logger = compilation.getLogger(`webpack.${PLUGIN_NAME}`);
				const fs = /** @type {OutputFileSystem} */ (compiler.outputFileSystem);

				if (!fs.readdir) {
					return callback(
						new Error(
							`${PLUGIN_NAME}: Output filesystem doesn't support listing directories (readdir)`
						)
					);
				}

				/** @type {Assets} */
				const currentAssets = new Map();
				const now = Date.now();
				for (const asset of Object.keys(compilation.assets)) {
					if (/^[A-Za-z]:\\|^\/|^\\\\/.test(asset)) continue;
					let normalizedAsset;
					let newNormalizedAsset = asset.replace(/\\/g, "/");
					do {
						normalizedAsset = newNormalizedAsset;
						newNormalizedAsset = normalizedAsset.replace(
							/(^|\/)(?!\.\.)[^/]+\/\.\.\//g,
							"$1"
						);
					} while (newNormalizedAsset !== normalizedAsset);
					if (normalizedAsset.startsWith("../")) continue;
					const assetInfo = compilation.assetsInfo.get(asset);
					if (assetInfo && assetInfo.hotModuleReplacement) {
						currentAssets.set(normalizedAsset, now + _10sec);
					} else {
						currentAssets.set(normalizedAsset, 0);
					}
				}

				const outputPath = compilation.getPath(compiler.outputPath, {});

				/**
				 * @param {string} path path
				 * @returns {boolean | void} true, if needs to be kept
				 */
				const isKept = (path) => {
					const result = hooks.keep.call(path);
					if (result !== undefined) return result;
					return keepFn(path);
				};

				/**
				 * @param {(Error | null)=} err err
				 * @param {Diff=} diff diff
				 */
				const diffCallback = (err, diff) => {
					if (err) {
						oldAssets = undefined;
						callback(err);
						return;
					}
					applyDiff(
						fs,
						outputPath,
						dry,
						logger,
						/** @type {Diff} */ (diff),
						isKept,
						(err, keptAssets) => {
							if (err) {
								oldAssets = undefined;
							} else {
								if (oldAssets) mergeAssets(currentAssets, oldAssets);
								oldAssets = currentAssets;
								if (keptAssets) mergeAssets(oldAssets, keptAssets);
							}
							callback(err);
						}
					);
				};

				if (oldAssets) {
					diffCallback(null, getDiffToOldAssets(currentAssets, oldAssets));
				} else {
					getDiffToFs(fs, outputPath, currentAssets, diffCallback);
				}
			}
		);
	}
}

module.exports = CleanPlugin;
module.exports._getDirectories = getDirectories;
module.exports._hasFile = hasFile;
module.exports._isEqualPath = isEqualPath;
