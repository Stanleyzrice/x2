-- 上品的表：店铺设置、商品稿、图。
-- 每个进程第一次用库时跑一遍（平台的先跑，再按注册的先后跑每个业务工具的 schema.sql）：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（网页上显示中文，见各自的 tables.ts）；给人看的值（类别、状态）用中文。
create table if not exists shop_settings (
	shop text primary key,
	-- Shopee 的店铺 id：x2 按它找这家店的浏览器（不是卖家账号 id，两个不一样）
	shop_id text not null unique,
	fx numeric not null default 4.4 check (fx > 0),
	price_per_kg_rmb numeric not null default 10.8 check (price_per_kg_rmb >= 0),
	label_fee_rmb numeric not null default 1.5 check (label_fee_rmb >= 0),
	weight_rounding_kg numeric not null default 0.01 check (weight_rounding_kg >= 0),
	return_loss_rate numeric not null default 0.03 check (return_loss_rate between 0 and 1),
	min_margin_rate numeric not null default 0.25 check (min_margin_rate between 0 and 1),
	min_margin_rmb numeric not null default 8 check (min_margin_rmb >= 0),
	commission_rate numeric not null default 0.06 check (commission_rate between 0 and 1),
	pre_order_rate numeric not null default 0.03 check (pre_order_rate between 0 and 1),
	payment_rate numeric not null default 0.025 check (payment_rate between 0 and 1),
	coin_rate numeric not null default 0 check (coin_rate between 0 and 1),
	free_shipping_rate numeric not null default 0.06 check (free_shipping_rate between 0 and 1),
	free_shipping_min_twd numeric not null default 0 check (free_shipping_min_twd >= 0),
	shipping_net_twd numeric not null default 0,
	pre_order boolean not null default true,
	min_purchase int not null default 1 check (min_purchase >= 1),
	stock_cap int not null default 50 check (stock_cap >= 0),
	channels text not null default '30005,30006,30012,30015,30017,30018,30020',
	categories jsonb,
	watermark_text text,
	watermark_size int not null default 32 check (watermark_size between 8 and 200),
	watermark_opacity numeric not null default 0.35 check (watermark_opacity between 0 and 1),
	watermark_position text not null default 'bottom-right' check (watermark_position in ('top-left', 'top-right', 'center', 'bottom-left', 'bottom-right')),
	paused text,
	updated_at timestamptz not null default now()
);
-- 已有店铺先排除：旧库可能已移除默认值，ON CONFLICT 不能跳过候选行的非空校验。
insert into shop_settings (shop, shop_id, coin_rate, free_shipping_min_twd)
select seed.* from (values ('ni1206', '348425', 0, 60), ('cheeroutdoor', '1554182542', 0.015, 0)) as seed(shop, shop_id, coin_rate, free_shipping_min_twd)
where not exists (select 1 from shop_settings existing where existing.shop = seed.shop)
on conflict do nothing;

create table if not exists listings (
	id bigserial primary key,
	shop text not null,
	offer_id text not null,
	strategy text not null default '人选',
	cancelled boolean not null default false,
	weight_kg numeric check (weight_kg > 0),
	freight_rmb numeric check (freight_rmb >= 0),
	title text,
	description text,
	note text,
	offer jsonb,
	offer_read_at timestamptz,
	category_id bigint,
	category_path jsonb,
	category_name text,
	attributes jsonb,
	attributes_text text,
	days_to_ship int,
	variants jsonb,
	images jsonb not null default '{}',
	pricing jsonb,
	audit jsonb,
	problems text,
	step text,
	step_detail text,
	product_id text,
	listed_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (shop, offer_id)
);

create table if not exists images (
	sha256 text primary key,
	kind text not null,
	source text,
	from_sha text,
	mime text,
	width int,
	height int,
	bytes bytea,
	verdict text,
	checks jsonb not null default '{}',
	created_at timestamptz not null default now()
);

create table if not exists shop_images (
	shop text not null,
	sha256 text not null,
	image_id text not null,
	width int,
	height int,
	uploaded_at timestamptz not null default now(),
	primary key (shop, sha256)
);

alter table listings add column if not exists removed_images jsonb not null default '[]';
alter table listings add column if not exists removed_variants jsonb not null default '[]';
alter table listings alter column variants drop not null;
alter table listings alter column variants drop default;
alter table listings add column if not exists kept_images jsonb not null default '[]';
do $$ begin
	if not exists (select 1 from pg_constraint where conname = 'listings_shop_fkey') then
		alter table listings add constraint listings_shop_fkey foreign key (shop) references shop_settings (shop);
	end if;
end $$;
alter table listings drop column if exists main_images;
alter table listings drop column if exists detail_images;
alter table listings drop column if exists option_images;
alter table listings drop column if exists variants_text;
alter table listings add column if not exists nickname text;

alter table listings add column if not exists pick_why text;
alter table listings add column if not exists pick_evidence text;
alter table listings add column if not exists pick_snapshot jsonb;

alter table listings add column if not exists noted text;

update listings set images = images - 'shown' where images ? 'shown';
drop trigger if exists listings_approve on listings;
drop function if exists listings_approve();
alter table listings drop column if exists approve;
alter table listings drop column if exists approved_at;
alter table listings drop column if exists approved_hash;
alter table listings drop column if exists content_hash;
alter table listings drop column if exists unapproved_why;

-- 可选的百分比费用模型输入；null 使用原有数值模型。
alter table shop_settings add column if not exists pricing_template jsonb;

-- 单稿最低购买数量；null 沿用 shop_settings.min_purchase，不改全店配置。
alter table listings add column if not exists min_purchase int check (min_purchase > 0);

-- 用户授权的单稿类目例外，保存叶子和理由；null仍按全店允许范围。
alter table listings add column if not exists category_exception jsonb;
