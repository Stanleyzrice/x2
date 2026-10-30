// 临时库的名字：源库名 + _scratch_ + 进程号；只认这个名字的、进程不在了的才清掉，源库和别的库不碰
import assert from "node:assert/strict";
import { test } from "node:test";
import { orphans, scratchOf } from "./scratch.ts";

test("临时库换掉地址里的库名，别的（用户、主机、参数）不变", () => {
	assert.deepEqual(scratchOf("postgres://localhost/x2", 42), { name: "x2_scratch_42", url: "postgres://localhost/x2_scratch_42" });
	assert.deepEqual(scratchOf("postgres://u:p@nas:5433/x2?sslmode=disable", 7), {
		name: "x2_scratch_7",
		url: "postgres://u:p@nas:5433/x2_scratch_7?sslmode=disable",
	});
	assert.throws(() => scratchOf("postgres://localhost/", 1));
});

test("要清掉的只有这个源库的、进程不在了的临时库", () => {
	const names = ["x2", "x2_test", "x2_scratch_1", "x2_scratch_2", "x2_scratch_x", "x2_scratch_", "x3_scratch_1", "postgres"];
	assert.deepEqual(
		orphans(names, "x2", (pid) => pid === 2),
		["x2_scratch_1"],
	);
});
