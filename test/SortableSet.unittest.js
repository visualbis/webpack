"use strict";

const SortableSet = require("../lib/util/SortableSet");

describe("util/SortableSet", () => {
	it("can be constructed like a normal Set", () => {
		const sortableSet = new SortableSet([1, 1, 1, 1, 1, 4, 5, 2], () => {});
		expect([...sortableSet]).toEqual([1, 4, 5, 2]);
	});

	it("can sort its content", () => {
		const sortableSet = new SortableSet(
			[1, 1, 1, 6, 6, 1, 1, 4, 5, 2, 3, 8, 5, 7, 9, 0, 3, 1],
			(a, b) => a - b
		);
		sortableSet.sort();
		expect([...sortableSet]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("can sort by a specified function", () => {
		const sortableSet = new SortableSet(
			[1, 1, 1, 6, 6, 1, 1, 4, 5, 2, 3, 8, 5, 7, 9, 0, 3, 1],
			(a, b) => a - b
		);
		sortableSet.sortWith((a, b) => b - a);
		expect([...sortableSet]).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
	});

	it("can sort by a specified function and convert to JSON", () => {
		const sortableSet = new SortableSet(
			[1, 1, 1, 6, 6, 1, 1, 4, 5, 2, 3, 8, 5, 7, 9, 0, 3, 1],
			(a, b) => a - b
		);
		sortableSet.sortWith((a, b) => b - a);
		expect(sortableSet.toJSON()).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
	});
});
