-- 平台的表：写入、已处理、页（网页上 agent 放组件的地方）。
-- 每个进程第一次用库时跑一遍（平台的先跑，再按注册的先后跑每个业务工具的 schema.sql）：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（网页上显示中文，见各自的 tables.ts）；给人看的值（类别、状态）用中文。
create table if not exists handled (
	key text primary key,
	note text,
	at timestamptz not null default now()
);

create sequence if not exists batch_seq;

create table if not exists writes (
	id bigserial primary key,
	batch bigint not null,
	op text not null,
	target text not null,
	params jsonb not null,
	display text,
	key text not null,
	status text not null default '待执行',
	response jsonb,
	readback jsonb,
	error text,
	host text,
	created_at timestamptz not null default now(),
	started_at timestamptz,
	finished_at timestamptz,
	cost numeric
);
create index if not exists writes_key on writes (key);
create index if not exists writes_batch on writes (batch);

drop table if exists inbox;
alter table writes alter column status set default '待执行';
update writes set status = '未执行', error = coalesce(error, '没有批准就没执行：批准的流程去掉了'), finished_at = coalesce(finished_at, now()) where status in ('待批准', '已批准');
alter table writes drop column if exists include;

-- 页原来叫会话（sessions、session_items）：改名保留数据，重复跑不出错
alter table if exists sessions rename to pages;
alter sequence if exists sessions_id_seq rename to pages_id_seq;
alter index if exists sessions_pkey rename to pages_pkey;
alter table if exists session_items rename to page_items;
alter sequence if exists session_items_id_seq rename to page_items_id_seq;
alter index if exists session_items_pkey rename to page_items_pkey;
alter index if exists session_items_session rename to page_items_page;
do $$
begin
	if exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'page_items' and column_name = 'session_id') then
		alter table page_items rename column session_id to page_id;
	end if;
	if exists (select 1 from pg_constraint where conname = 'session_items_session_id_fkey') then
		alter table page_items rename constraint session_items_session_id_fkey to page_items_page_id_fkey;
	end if;
end
$$;

create table if not exists pages (
	id bigserial primary key,
	title text not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
create table if not exists page_items (
	id bigserial primary key,
	page_id bigint not null references pages (id) on delete cascade,
	component text not null,
	props jsonb not null,
	created_at timestamptz not null default now()
);
create index if not exists page_items_page on page_items (page_id);

-- 加列
alter table writes add column if not exists pid int;
alter table page_items add column if not exists answer jsonb;
alter table page_items add column if not exists answered_at timestamptz;
