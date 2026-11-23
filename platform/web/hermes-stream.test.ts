import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { HermesLiveRun } from "./hermes-stream.ts";

function subscriber() {
	const frames: string[] = [];
	const transport = Object.assign(new EventEmitter(), {
		writableLength: 0,
		write: (frame: string) => {
			frames.push(frame);
		},
		end: () => {
			transport.emit("close");
		},
	});
	return { frames, res: transport as unknown as ServerResponse };
}

test("回复流的后来订阅者先收到已生成原文，后续只收到增量", () => {
	const live = new HermesLiveRun();
	const first = subscriber(),
		resumed = subscriber();
	live.subscribe(first.res);
	live.append("甲");
	live.append("乙");
	live.subscribe(resumed.res);
	assert.deepEqual(first.frames, ['event: snapshot\ndata: {"text":"","trace":[]}\n\n', 'event: delta\ndata: "甲乙"\n\n']);
	assert.deepEqual(resumed.frames, ['event: snapshot\ndata: {"text":"甲乙","trace":[]}\n\n']);
	live.append("丙");
	live.finish();
	assert.deepEqual(resumed.frames.slice(1), ['event: delta\ndata: "丙"\n\n', "event: done\ndata: null\n\n"]);
});

test("进入工具阶段后清除上一段草稿，正文重新开始", () => {
	const live = new HermesLiveRun();
	const viewer = subscriber();
	live.subscribe(viewer.res);
	live.append("尚未完成的旧文字");
	live.append(null);
	live.append("新的正文");
	live.finish();
	assert.deepEqual(viewer.frames.slice(1), ["event: reset\ndata: null\n\n", 'event: delta\ndata: "新的正文"\n\n', "event: done\ndata: null\n\n"]);
});
