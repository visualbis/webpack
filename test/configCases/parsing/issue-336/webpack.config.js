"use strict";

const ProvidePlugin = require("../../../../").ProvidePlugin;

/** @type {import("../../../../").Configuration} */
module.exports = {
	plugins: [
		new ProvidePlugin({
			aaa: "aaa"
		})
	]
};
