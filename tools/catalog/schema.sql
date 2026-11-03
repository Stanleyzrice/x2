-- Catalog 保存网站目录快照及同步批次；刷新失败不替换当前快照，不改变 Orders 的现读逻辑。
create table if not exists catalog_syncs (
	id text primary key,
	shop text not null,
	shop_id text not null,
	scope text not null check (scope = 'all'),
	status text not null check (status in ('running', 'complete', 'partial', 'failed')),
	started_at timestamptz not null,
	captured_at timestamptz,
	finished_at timestamptz,
	complete boolean not null default false,
	details_complete boolean not null default false,
	expected_count int,
	product_count int,
	error text
);
alter table catalog_syncs add column if not exists backend_pid int;
alter table catalog_syncs add column if not exists phase text;
alter table catalog_syncs add column if not exists page int;
alter table catalog_syncs add column if not exists observed int;
create index if not exists catalog_syncs_shop_time on catalog_syncs (shop, shop_id, started_at desc);
create table if not exists catalog_products (
	shop text not null,
	shop_id text not null,
	revision text not null references catalog_syncs (id),
	product_id text not null,
	name text not null,
	parent_sku text,
	cover text,
	status int,
	status_label text not null,
	stock_state text not null check (stock_state in ('in_stock', 'sold_out', 'unknown')),
	price_min numeric,
	price_max numeric,
	stock_total numeric,
	models jsonb,
	facts jsonb not null,
	captured_at timestamptz not null,
	primary key (shop, shop_id, revision, product_id)
);
create table if not exists catalog_heads (
	shop text not null,
	shop_id text not null,
	revision text not null references catalog_syncs (id),
	primary key (shop, shop_id)
);
create or replace view catalog_current_products as
	select p.* from catalog_products p join catalog_heads h on h.shop = p.shop and h.shop_id = p.shop_id and h.revision = p.revision;

-- 每个 request_id 冻结一个人工确认的商品状态修改，重复确认或核对不得重新提交。
create table if not exists catalog_status_intents (
	request_id text primary key,
	shop text not null,
	shop_id text not null,
	product_id text not null,
	target_state text not null check (target_state in ('listed', 'unlisted')),
	input jsonb not null,
	expected jsonb not null,
	fingerprint text not null,
	claimed boolean not null default false,
	submission_started boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists catalog_status_product_time on catalog_status_intents (shop, shop_id, product_id, created_at desc);
