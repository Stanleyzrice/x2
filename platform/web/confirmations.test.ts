// 确认只绑定准确引用，JSON键顺序不影响，身份与政策变化或过期必须重新确认。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkConfirmation, referenceHash } from "./confirmations.ts";

test("确认绑定组件、店铺和政策，键顺序不造成误判", () => {
	const props = { shop: "one", policyPath: "rules" };
	const saved = { reference_hash: referenceHash("chat", props), expires_at: new Date("2030-01-01") };
	assert.doesNotThrow(() => checkConfirmation(saved, "chat", { policyPath: "rules", shop: "one" }));
	assert.throws(() => checkConfirmation(saved, "chat", { ...props, shop: "two" }), /引用已变化/);
	assert.throws(() => checkConfirmation(saved, "other", props), /引用已变化/);
	assert.throws(() => checkConfirmation(saved, "chat", props, new Date("2030-01-02")), /过期/);
});
