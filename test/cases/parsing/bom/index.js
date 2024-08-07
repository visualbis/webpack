it("should load a utf-8 file with BOM", function () {
	var result = require("./bomfile");
	expect(result).toEqual("ok");
});

it("should load a css file with BOM", function () {
	var css = require("!css-loader!./bomfile.css").default + "";
	expect(css.replace(/\n\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1')).toBe("body{color:#abc}");
});

it("should load a json file with BOM", function () {
	var result = require("./bomfile.json");
	expect(result.message).toEqual("ok");
});
