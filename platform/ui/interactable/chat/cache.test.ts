// Chat 快照的身份隔离、立即回显和后台更新测试；不读取真实买家资料。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Inbox, inboxSnapshots, snapshotKey } from "./cache.ts";

test("Chat 快照可同步回显，店铺/窗口/会话隔离，每次读取仍更新且合并并发", async () => {
	const key = snapshotKey("test-item", "one", 7);
	const inbox: Inbox = { shop: "one", rows: [], next: null, capturedAt: "before", scope: "fixture", window: { days: 7, from: "", to: "" } };
	let reads = 0;
	await inboxSnapshots.read(key, async () => inbox);
	assert.equal(inboxSnapshots.peek(key), inbox);
	assert.equal(inboxSnapshots.peek(snapshotKey("test-item", "two", 7)), null);
	assert.equal(inboxSnapshots.peek(snapshotKey("test-item", "one", 30)), null);
	assert.notEqual(snapshotKey("test-item", "one", 7, "12"), snapshotKey("test-item", "one", 7, "13"));
	const updated = { ...inbox, capturedAt: "after" };
	const load = async () => {
		reads++;
		return updated;
	};
	await Promise.all([inboxSnapshots.read(key, load), inboxSnapshots.read(key, load)]);
	assert.equal(reads, 1);
	assert.equal(inboxSnapshots.peek(key), updated);
	inboxSnapshots.invalidate(key);
});
