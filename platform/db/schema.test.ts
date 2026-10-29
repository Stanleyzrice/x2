// 表结构能重复跑：每个 x2 进程第一次连库都把所有 schema.sql 跑一遍（index.ts 的 migrate），每一句跑第二遍都不能出错、不能多插数据。
// 静态查 sql 文本，不连库：建的要 if not exists，删的要 if exists，改名先 if exists，函数、触发器 or replace，插数据 on conflict
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const FILES = [
	"platform/db/schema.sql",
	...readdirSync(join(ROOT, "tools"))
		.map((d) => `tools/${d}/schema.sql`)
		.filter((f) => existsSync(join(ROOT, f))),
];

/** 拆成一句一句（小写、空白并成一个）：去掉 -- 注释；字符串、do $$ … $$ 里的分号不拆 */
function statements(text: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote = false;
	let dollar = false;
	for (let i = 0; i < text.length; i++) {
		if (!quote && !dollar && text.startsWith("--", i)) {
			const nl = text.indexOf("\n", i);
			i = nl < 0 ? text.length : nl;
			continue;
		}
		if (!quote && text.startsWith("$$", i)) {
			dollar = !dollar;
			cur += "$$";
			i++;
			continue;
		}
		if (!dollar && text[i] === "'") quote = !quote;
		if (!quote && !dollar && text[i] === ";") {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += text[i];
	}
	out.push(cur);
	return out.map((s) => s.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
}

/** alter table 的几个动作，按括号外的逗号拆 */
function actions(rest: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const c of rest) {
		if (c === "(") depth++;
		if (c === ")") depth--;
		if (c === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	out.push(cur.trim());
	return out;
}

/** 一份 schema.sql 里跑第二遍会出错（或多插数据）的句子 */
function problems(text: string): string[] {
	const bad: string[] = [];
	const dropped = new Set<string>();
	for (const s of statements(text)) {
		const no = (why: string) => bad.push(`${why}：${s.slice(0, 80)}`);
		if (s.startsWith("do ")) {
			if (!/\bif (not )?exists\b/.test(s)) no("do 块里先查有没有（if exists / if not exists）再改");
			continue;
		}
		if (/^create (unique )?(table|index|sequence|schema|extension|materialized view) (?!if not exists\b)/.test(s)) no("create 要写 if not exists");
		if (/^create (?!or replace )(function|procedure|trigger|view)\b/.test(s)) no("create function、trigger、view 要写 or replace");
		if (/^drop (table|index|sequence|function|procedure|trigger|view|materialized view|type|schema|extension) (?!if exists\b)/.test(s))
			no("drop 要写 if exists");
		if (/^alter (sequence|index|view) (?!if exists\b).* rename /.test(s)) no("改名要写 alter … if exists");
		if (/^insert /.test(s) && !/ on conflict /.test(s)) no("insert 要写 on conflict（跑第二遍不多插）");
		const m = s.match(/^alter table (if exists )?(only )?\S+ (.*)$/);
		if (!m) continue;
		for (const a of actions(m[3]!)) {
			const named = a.match(/^drop constraint if exists (\S+)/);
			if (named) dropped.add(named[1]!);
			if (/^add (column )?(?!constraint |primary key|unique|check|foreign key|if not exists)/.test(a) && !/^add column if not exists /.test(a))
				no("add column 要写 if not exists");
			const added = a.match(/^add constraint (\S+)/);
			if (added && !dropped.has(added[1]!)) no(`add constraint 前面先 drop constraint if exists ${added[1]}（或写在 do 块里先查有没有）`);
			if (/^add (primary key|unique|check|foreign key)/.test(a)) no("add 约束要起名字（add constraint 名字），前面先 drop constraint if exists");
			if (/^drop /.test(a) && !/^drop (column |constraint )?if exists\b/.test(a)) no("drop column、constraint 要写 if exists");
			if (/^rename /.test(a) && !m[1]) no("改名要写 alter table if exists");
			if (/^rename (column|constraint) /.test(a)) no("改列名、约束名要写在 do 块里先查有没有（改过以后旧名字就不在了）");
		}
	}
	return bad;
}

test("每份 schema.sql 跑第二遍不出错、不多插数据", () => {
	assert.ok(FILES.length >= 2, "找到 platform 和 tools 的 schema.sql");
	assert.deepEqual(
		FILES.flatMap((f) => problems(readFileSync(join(ROOT, f), "utf8")).map((p) => `${f}：${p}`)),
		[],
	);
});

test("查得出跑第二遍会出错的写法", () => {
	const bad = [
		"create table t (a int);",
		"create unique index t_a on t (a);",
		"create sequence s;",
		"alter table t add column b int;",
		"alter table t add b int;",
		"alter table t add column if not exists b int, add column c int;",
		"alter table t drop column b;",
		"alter table t drop b;",
		"alter table t drop constraint t_check;",
		"alter table t add constraint t_check check (a > 0);",
		"drop table t;",
		"drop trigger tr on t;",
		"drop function f();",
		"alter table t rename to u;",
		"alter table if exists t rename column a to b;",
		"alter sequence t_id_seq rename to u_id_seq;",
		"create function f() returns int as $$ select 1; $$ language sql;",
		"create trigger tr after insert on t for each row execute function f();",
		"insert into t (a) values (1);",
		"do $$ begin alter table t rename column a to b; end $$;",
	];
	for (const s of bad) assert.equal(problems(s).length, 1, s);
	const good = [
		"create table if not exists t (a numeric(10, 2), b text default 'x;y'); -- 注释里的 create table t;",
		"alter table t add column if not exists b int, alter column a drop not null, alter column a drop default;",
		"alter table t drop constraint if exists t_check; alter table t add constraint t_check check (a > 0);",
		"alter table if exists t rename to u; alter index if exists t_pkey rename to u_pkey;",
		"create or replace function f() returns int as $$ select 1; $$ language sql;",
		"insert into t (a) values (1) on conflict do nothing;",
		"do $$ begin if exists (select 1 from information_schema.columns where column_name = 'a') then alter table t rename column a to b; end if; end $$;",
	];
	for (const s of good) assert.deepEqual(problems(s), [], s);
});
