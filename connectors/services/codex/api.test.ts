// Codex CLI：验证无shell执行、结构化结果、取消/超时与失败边界。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	askCodex,
	CODEX_MODEL,
	CODEX_REASONING_EFFORT,
	CodexTimeoutError,
	codexArgs,
	codexStatus,
	progressOf,
	runCodexProcess,
	safeCodexError,
} from "./api.ts";

async function fakeCli() {
	const dir = await mkdtemp(join(tmpdir(), "x2-codex-test-"));
	const path = join(dir, "codex-test");
	await writeFile(
		path,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args.includes('--version')) { process.stdout.write('codex-cli test\\n'); process.exit(0); }
if(args.includes('--help')) { process.stdout.write('--ignore-user-config --model --config --ephemeral --sandbox --json --output-schema --output-last-message'); process.exit(0); }
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>prompt+=v);
process.stdin.on('end',()=>{
 const out=args[args.indexOf('--output-last-message')+1];
 process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'private-thread-id'})+'\\n');
 if(prompt==='wait') { process.on('SIGTERM',()=>{fs.writeFileSync(out,'{"ok":true}');process.exit(0)});setTimeout(()=>{},30000);return; }
 if(prompt==='slow') { setTimeout(()=>fs.writeFileSync(out,'{"ok":true}'),200);return; }
 if(prompt==='stubborn') { process.on('SIGTERM',()=>{});setTimeout(()=>{},30000);return; }
 if(prompt==='group') {
  const child=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.writeFileSync(require('node:path').join(__dirname,'descendant-pid'),String(child.pid));
  process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>{},30000);return;
 }
 if(prompt==='flood') { process.stdout.write('x'.repeat(9*1024*1024));setTimeout(()=>{},30000);return; }
 if(prompt==='missing')return;
 fs.writeFileSync(out,prompt==='invalid'?'not json':JSON.stringify({ok:true,prompt}));
 if(prompt==='fail')process.exit(2);
});
`,
		{ mode: 0o700 },
	);
	return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("Codex执行参数只限本次只读结构化分析，不启用全局插件或shell", () => {
	const args = codexArgs("/repo with spaces", "/tmp/schema.json", "/tmp/result.json");
	assert.equal(args.includes("--ignore-user-config"), true);
	assert.equal(args[args.indexOf("--model") + 1], CODEX_MODEL);
	assert.equal(args.includes(`model_reasoning_effort="${CODEX_REASONING_EFFORT}"`), true);
	assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
	assert.equal(args[args.indexOf("-C") + 1], "/repo with spaces");
	assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
	assert.equal(args.includes("shell_tool"), true);
	assert.equal(args.at(-1), "-");
});

test("Codex状态只检查版本与帮助；分析通过stdin原样传入并解析最终JSON", async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	assert.deepEqual(await codexStatus(cli.path), {
		available: true,
		version: "codex-cli test",
		error: null,
		model: CODEX_MODEL,
		reasoningEffort: CODEX_REASONING_EFFORT,
	});
	const prompt = '只分析 $(not-a-command) `not-a-command` "报价"';
	const events: string[] = [];
	assert.deepEqual(await askCodex({ executable: cli.path, cwd: cli.dir, prompt, schema: { type: "object" }, onEvent: (e) => events.push(JSON.stringify(e)) }), {
		ok: true,
		prompt,
	});
	assert.equal(
		events.some((line) => line.includes("private-thread-id")),
		false,
	);
	assert.equal(
		events.some((line) => line.includes("会话已开始")),
		true,
	);
});

test("Codex非零退出、缺最终结果、非法JSON均不能冒充完成", async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	for (const [prompt, expected] of [
		["fail", /未成功退出/],
		["missing", /未生成最终/],
		["invalid", /不是有效JSON/],
	] as const)
		await assert.rejects(askCodex({ executable: cli.path, cwd: cli.dir, prompt, schema: {} }), expected);
});

test("Codex取消后即使进程写出合法结果并退出0，也返回取消", async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	const controller = new AbortController();
	const result = askCodex({ executable: cli.path, cwd: cli.dir, prompt: "wait", schema: {}, signal: controller.signal, onEvent: () => controller.abort() });
	await assert.rejects(result, /取消/);
});

test("Codex超时不返回任何结构化成功结果", async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	await assert.rejects(askCodex({ executable: cli.path, cwd: cli.dir, prompt: "wait", schema: {}, timeoutMs: 150 }), (error: unknown) => {
		assert.ok(error instanceof CodexTimeoutError);
		assert.equal(error.code, "CODEX_TIMEOUT");
		assert.equal(error.timeoutMs, 150);
		assert.ok(error.elapsedMs >= 150);
		assert.match(error.message, /超时/);
		return true;
	});
});

test("等待心跳只报告耗时，完成或取消后立即清理，不泄露输入", async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	const args = codexArgs(cli.dir, join(cli.dir, "schema.json"), join(cli.dir, "result.json"));
	const events: { type: string; message: string; elapsedMs?: number; timeoutMs?: number }[] = [];
	const run = (signal?: AbortSignal) =>
		runCodexProcess({
			executable: cli.path,
			cwd: cli.dir,
			args,
			prompt: "slow",
			signal,
			timeoutMs: 1500,
			progressIntervalMs: 20,
			onEvent: (event) => events.push(event),
		});
	assert.equal((await run()).code, 0);
	const waiting = events.filter((event) => event.type === "analysis.waiting");
	assert.ok(waiting.length > 0);
	assert.ok(waiting.every((event) => typeof event.elapsedMs === "number" && event.timeoutMs === 1500 && !event.message.includes("slow")));
	const completedCount = events.length;
	await new Promise<void>((done) => setTimeout(done, 50));
	assert.equal(events.length, completedCount);
	const controller = new AbortController();
	const cancelled = runCodexProcess({
		executable: cli.path,
		cwd: cli.dir,
		args,
		prompt: "wait",
		signal: controller.signal,
		timeoutMs: 1500,
		progressIntervalMs: 20,
		onEvent: (event) => {
			events.push(event);
			if (event.type === "analysis.waiting") controller.abort();
		},
	});
	await assert.rejects(cancelled, /取消/);
	const cancelledCount = events.length;
	await new Promise<void>((done) => setTimeout(done, 50));
	assert.equal(events.length, cancelledCount);
});

test("超时等待无响应进程被强制关闭，取消不能被归为可重试超时", async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 300);
	t.after(() => clearTimeout(timer));
	await assert.rejects(
		askCodex({ executable: cli.path, cwd: cli.dir, prompt: "stubborn", schema: {}, timeoutMs: 150, signal: controller.signal }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(!(error instanceof CodexTimeoutError));
			assert.match(error.message, /取消/);
			return true;
		},
	);
});

test("超时主进程先退出时也停止同组子进程，才交还可重试错误", { skip: process.platform === "win32" }, async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	await assert.rejects(askCodex({ executable: cli.path, cwd: cli.dir, prompt: "group", schema: {}, timeoutMs: 500 }), CodexTimeoutError);
	const { readFile } = await import("node:fs/promises");
	const pid = Number(await readFile(join(cli.dir, "descendant-pid"), "utf8"));
	assert.throws(
		() => process.kill(pid, 0),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
	);
});

test("输出超限不会被分类为可重试的模型超时", async (t) => {
	const cli = await fakeCli();
	t.after(cli.cleanup);
	await assert.rejects(askCodex({ executable: cli.path, cwd: cli.dir, prompt: "flood", schema: {}, timeoutMs: 2000 }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.ok(!(error instanceof CodexTimeoutError));
		assert.match(error.message, /输出超过/);
		return true;
	});
});

test("进度不转发模型原文或命令参数，诊断隐藏凭证", () => {
	assert.equal(progressOf(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "secret command" } })), null);
	assert.deepEqual(progressOf(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "private input" } })), {
		type: "item.completed",
		message: "智能体已生成结构化结论",
	});
	assert.equal(safeCodexError(new Error("api_key=abc token=def Bearer supersecret https://example.test/?token=abc")).includes("supersecret"), false);
});
