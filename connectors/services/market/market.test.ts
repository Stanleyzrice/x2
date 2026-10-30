// 知虾镜像的回包解析：样本照 /api/sql 的说法写的；行原样回，回的是数组也认
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rowsOf } from "./api.ts";

test("/api/sql：{ rows } 或行的数组都认，行原样回；别的样子报回包变了", () => {
	assert.deepEqual(rowsOf(JSON.parse(readFileSync(new URL("./fixtures/sql.json", import.meta.url), "utf8"))), { rows: [{ "?column?": 1 }] });
	assert.deepEqual(rowsOf([{ a: 1 }]), { rows: [{ a: 1 }] });
	assert.throws(() => rowsOf("oops"), /知虾镜像 \/api\/sql 的回包变了/);
});
