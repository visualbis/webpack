This configuration will enable the none output for the stats report.

You see that everything is working nicely together.

# example.js

```javascript
console.log("Hello World!");
```

# webpack.config.js

```javascript
"use strict";

const path = require("path");

module.exports = {
    output: {
		path: path.join(__dirname, "dist"),
		filename: "output.js"
	},
	stats: "none"
};
```

# dist/output.js

```javascript
/******/ (() => { // webpackBootstrap
/*!********************!*\
  !*** ./example.js ***!
  \********************/
/*! unknown exports (runtime-defined) */
/*! runtime requirements:  */
console.log("Hello World!");

/******/ })()
;
```

# Info

## Production mode

```

```
