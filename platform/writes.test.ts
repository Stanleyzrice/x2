// 写入引擎的判断：没核清的同一个对象不再做；结果未知停下这一批、不重发；被拒的记下原因，同一个 key 再交加次数
import assert from "node:assert/strict";
import { test } from "node:test";
import { admit, failed, gate, LOOK, type Stuck, settle, stuck } from "./writes.ts";

const none = (): Stuck => ({ batches: new Set(), targets: new Set() });
const w = { op: "试写", batch: "1", target: "t:1" };
const ok = { known: true, blocked: null, stuck: none(), tried: false, dup: null };

test("写入：没核清的同一个 key 不再收新的；做过、被拒过的再交加次数", () => {
	assert.deepEqual(admit("k:1", []), { key: "k:1" });
	assert.deepEqual(admit("k:1", [{ id: "3", status: "结果未知" }]), { busy: "3" });
	assert.deepEqual(admit("k:1", [{ id: "3", status: "已提交" }]), { busy: "3" });
	assert.deepEqual(admit("k:1", [{ id: "3", status: "不一致" }]), { busy: "3" });
	assert.deepEqual(admit("k:4", [{ id: "5", status: "被拒" }]), { key: "k:4#2" });
	assert.deepEqual(
		admit("k:4", [
			{ id: "5", status: "被拒" },
			{ id: "6", status: "已核对" },
		]),
		{ key: "k:4#3" },
	);
});

test("写入：结果未知停下这一批和同一个对象（剩下的未执行）；要人处理的停下全部；没跑过的要 --try；重复的不做", () => {
	assert.equal(gate(w, ok), null);
	assert.equal(gate(w, { ...ok, stuck: { batches: new Set(["1"]), targets: new Set() } }), "这一批（或同一个对象）有结果未知的写入：先核清再做");
	assert.equal(
		gate({ ...w, batch: "2" }, { ...ok, stuck: { batches: new Set(), targets: new Set(["t:1"]) } }),
		"这一批（或同一个对象）有结果未知的写入：先核清再做",
	);
	assert.equal(gate(w, { ...ok, blocked: "1688 要过滑块" }), "没做：1688 要过滑块");
	assert.equal(gate(w, { ...ok, known: false }), "没有 试写 这个写操作");
	assert.equal(gate(w, { ...ok, untried: "还没在真站点上跑过：加 --try" }), "还没在真站点上跑过：加 --try");
	assert.equal(gate(w, { ...ok, untried: "还没在真站点上跑过：加 --try", tried: true }), null);
	assert.equal(gate(w, { ...ok, dup: "7" }), "重复：写入 #7 已经做过（或还没核清）");
});

test("写入：站点的答复和读回来的合成状态；看不出做没做是结果未知，停下、不重发", () => {
	assert.deepEqual(settle({ kind: "done" }, true), { status: "已核对" });
	assert.deepEqual(settle({ kind: "unknown", why: "超时" }, true), { status: "已核对" });
	assert.deepEqual(settle({ kind: "unknown", why: "超时" }, null), { status: "结果未知", why: "读回来看不出做没做（超时）" });
	assert.deepEqual(settle({ kind: "done" }, null), { status: "结果未知", why: "读回来看不出做没做" });
	assert.deepEqual(settle({ kind: "done" }, false), { status: "不一致", why: "站点说做了，读回来没有" });
	assert.deepEqual(settle({ kind: "refused", why: "库存不够" }, false), { status: "被拒", why: "没做成：库存不够" });
	assert.deepEqual(["结果未知", "不一致", "被拒", "已核对"].map(stuck), [true, true, false, false]);
});

test("写入：执行时抛了错，没记意图的是未执行、提交了没核清的是结果未知；已经有结果的不改（做成了以后 after 更新库出错，不能记成未执行：那样会再加购一次）", () => {
	assert.equal(failed("待执行"), "未执行");
	assert.equal(failed("已提交"), "结果未知");
	assert.equal(failed("结果未知"), "结果未知");
	assert.equal(failed("已核对"), null);
	assert.equal(failed("被拒"), null);
	assert.equal(failed("未执行"), null);
});

test("写入：人到站点上核的只有结果未知、不一致；已提交的可能还在路上，先读回来", () => {
	assert.deepEqual(LOOK, ["结果未知", "不一致"]);
});
