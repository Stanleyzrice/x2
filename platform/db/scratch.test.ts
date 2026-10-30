// 临时库的名字：源库名 + _scratch_ + 电脑 + 进程号；只认这台电脑上这个名字的、进程不在了的才清掉，源库、别的电脑的、别的库不碰
import assert from "node:assert/strict";
import { test } from "node:test";
import { orphans, scratchOf } from "./scratch.ts";

test("临时库换掉地址里的库名，别的（用户、主机、参数）不变", () => {
	assert.deepEqual(scratchOf("postgres://localhost/x2", "ab12", 42), { name: "x2_scratch_ab12_42", url: "postgres://localhost/x2_scratch_ab12_42" });
	assert.deepEqual(scratchOf("postgres://u:p@nas:5433/x2?sslmode=disable", "ab12", 7), {
		name: "x2_scratch_ab12_7",
		url: "postgres://u:p@nas:5433/x2_scratch_ab12_7?sslmode=disable",
	});
	assert.throws(() => scratchOf("postgres://localhost/", "ab12", 1));
});

test("要清掉的只有这个源库的、这台电脑上进程不在了的临时库（库是共用的，同事的临时库进程号在这台电脑上看着像不在了）", () => {
	const names = [
		"x2",
		"x2_test",
		"x2_scratch_ab12_1",
		"x2_scratch_ab12_2",
		"x2_scratch_cd34_1",
		"x2_scratch_ab12_x",
		"x2_scratch_ab12_",
		"x3_scratch_ab12_1",
		"postgres",
	];
	assert.deepEqual(
		orphans(names, "x2", "ab12", (pid) => pid === 2),
		["x2_scratch_ab12_1"],
	);
});
