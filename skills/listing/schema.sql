-- 上品的表：店铺设置、商品稿、图。
-- 每个进程第一次用库时跑一遍（平台的先跑，再按注册的先后跑每个 skill 的 schema.sql）：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（网页上显示中文，见各自的 tables.ts）；给人看的值（类别、状态）用中文。

-- ── 上品 ──

-- 店铺设置：一家店一行，人定的：核价参数、上品的默认值、允许的类目、水印、暂停上品。在网页上改；比例在 0–1、汇率大于 0，填错存不进
-- 核价参数的默认值是 lilto 的 landed-cost.json（2026-09-02 依账单和结算截图定）
create table if not exists shop_settings (
	shop text primary key,
	-- Shopee 的店铺 id：x2 按它找这家店的浏览器（不是卖家账号 id，两个不一样）
	shop_id text not null unique,
	-- 核价
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
	-- 上品的默认值：预售（备货天数取类目的上限）、起购量、库存（取 1688 现在的库存和它的小的）、开哪些物流渠道（渠道 id，逗号分隔；30019 不支持较长备货）
	pre_order boolean not null default true,
	min_purchase int not null default 1 check (min_purchase >= 1),
	stock_cap int not null default 50 check (stock_cap >= 0),
	channels text not null default '30005,30006,30012,30015,30017,30018,30020',
	-- 允许的叶子类目 id（JSON 数组）；空是不限
	categories jsonb,
	-- 水印：文字空着就不能上品（两家店的封面要不一样）
	watermark_text text,
	watermark_size int not null default 32 check (watermark_size between 8 and 200),
	watermark_opacity numeric not null default 0.35 check (watermark_opacity between 0 and 1),
	watermark_position text not null default 'bottom-right' check (watermark_position in ('top-left', 'top-right', 'center', 'bottom-left', 'bottom-right')),
	-- 暂停上品原因（例 店铺被限制）：空是不暂停
	paused text,
	updated_at timestamptz not null default now()
);
-- 两家店的平台费不一样：ni1206 的免运方案费每单最低 NT$60；cheeroutdoor 有虾币回馈 1.5%
insert into shop_settings (shop, shop_id, coin_rate, free_shipping_min_twd) values ('ni1206', '348425', 0, 60), ('cheeroutdoor', '1554182542', 0.015, 0) on conflict do nothing;

-- 商品稿：一个货源 × 一家店。x2 做（读货源、类目属性、规格和价格、图），agent 写标题和描述，人在网页上审稿。
-- 人改：标题、描述、重量、国内运费、放弃（cancelled）、备注、策略；主图、详情图（删掉的那张就不要了）。重量、国内运费空着的 agent 估
create table if not exists listings (
	id bigserial primary key,
	shop text not null,
	-- 1688 的货源 id（人贴的链接，添加货源时改成 id）
	offer_id text not null,
	-- 从哪个策略来（现在都是人选的）：以后按策略看效果
	strategy text not null default '人选',
	cancelled boolean not null default false,
	-- 1688 没给重量时，每个规格都用它（kg）；国内运费（元 / 件）：1688 读不到时用它（包邮、读得到的不用填）。空着的 agent 估（往重了、往高了估），人可以改
	weight_kg numeric check (weight_kg > 0),
	freight_rmb numeric check (freight_rmb >= 0),
	title text,
	description text,
	note text,
	-- x2 做的：货源快照（标题、链接、主图、详情图、规格、服务、起订量）
	offer jsonb,
	offer_read_at timestamptz,
	category_id bigint,
	category_path jsonb,
	category_name text,
	-- 必填属性：[{ attribute_id, attribute_values: [{ value_id }] }]；attributes_text 给人看
	attributes jsonb,
	attributes_text text,
	days_to_ship int,
	-- 规格：层和规格一起存，{ tiers: [{ source（1688 的层名）, name, options: [{ source（1688 的原值）, name, image }] }],
	-- variants: [{ sku, skuId, specId, options（每层一个选项的下标）, costRmb, stock, weightKg, priceTwd }] }。做商品稿时从货源生成，以后都改它；空是还没做
	variants jsonb,
	-- 图：{ main: [...], detail: [...], options: {...}, sizeChart }，每张 { from（原图地址）, sha（原图）, final（成品）, imageId, width, height, verdict }
	images jsonb not null default '{}',
	-- 核价用的参数快照
	pricing jsonb,
	-- Gemini 文字检查的结果（只提示，不挡）
	audit jsonb,
	-- 检查算出来的
	problems text,
	step text,
	step_detail text,
	-- 建好以后
	product_id text,
	listed_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (shop, offer_id)
);

-- 图：一张图一行（字节的 sha256；1688 的地址带缓存参数，按地址认会重复付钱）。
-- 原图记来源和筛字结果；译图存字节（付过钱，象寄的地址大约 80 天失效）；checks 是 Gemini 的结果，按「检查:版本:模型」存
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

-- 成品传到哪家店、Shopee 的图片 id
create table if not exists shop_images (
	shop text not null,
	sha256 text not null,
	image_id text not null,
	width int,
	height int,
	uploaded_at timestamptz not null default now(),
	primary key (shop, sha256)
);
-- ── 加列（表建好以后加的列写在这里） ──

-- 已删除的图（Shopee 的图片 id）：人在网页上删的主图、详情图，再做商品稿也不用它
alter table listings add column if not exists removed_images jsonb not null default '[]';
-- 已移除的规格（货号，例 店里接不了的「定製」）：人说了，agent 用 x2 listing drop 写；再做商品稿也不要它
alter table listings add column if not exists removed_variants jsonb not null default '[]';
-- 规格存成层和规格（{ tiers, variants }），空是还没做商品稿；旧格式（规格的数组）的要重做商品稿
alter table listings alter column variants drop not null;
alter table listings alter column variants drop default;
-- 保留的图（Shopee 的图片 id）：人看过说要用的图（人说了，agent 用 x2 listing keep 写）：x2 去掉的放回来，以后 Gemini 文字检查再挑它也不去掉
alter table listings add column if not exists kept_images jsonb not null default '[]';
-- 商品稿的店铺：店铺设置里有的
do $$ begin
	if not exists (select 1 from pg_constraint where conname = 'listings_shop_fkey') then
		alter table listings add constraint listings_shop_fkey foreign key (shop) references shop_settings (shop);
	end if;
end $$;
-- 图在网页上照 images 现算（platform/web/tables.ts），不另存
alter table listings drop column if exists main_images;
alter table listings drop column if exists detail_images;
alter table listings drop column if exists option_images;
-- 规格和价格照 variants 现算（网页上是表格，命令行是 specsText），不另存
alter table listings drop column if exists variants_text;
-- 简称：人和 agent 认商品稿用的简体中文短名（最多 12 字，例 浴水生财猫狗地垫），不上 Shopee。x2 做商品稿时先填 1688 标题的前 12 个字，
-- 写文案的 agent 写标题时一起写（只在空着、还是自动填的那个值时写）；人在网页上改过的 agent 不再改
alter table listings add column if not exists nickname text;

-- 商品稿的选品理由（为什么选它，一两句）、依据（热搜词和搜索量、竞品价格和销量、1688 月销、报价……）；
-- 选品快照：加进来那一刻的策略（名字、版本号、假设、选法）和在用的选品规矩，{ at, backfilled, strategy, rules }。补记的 backfilled 是 true，at 是补记的时间
alter table listings add column if not exists pick_why text;
alter table listings add column if not exists pick_evidence text;
alter table listings add column if not exists pick_snapshot jsonb;

-- ── 备注 ──

-- 看过的备注：agent 照人写的「备注」做完，记下当时的备注原文（x2 listing noted）；备注再改，x2 status 的 todo 又给出来
alter table listings add column if not exists noted text;

-- images 不存 shown（放在建触发器之后）
update listings set images = images - 'shown' where images ? 'shown';
-- 批准去掉了：人在终端里说批准，agent 调写工具（x2 listing publish）
drop trigger if exists listings_approve on listings;
drop function if exists listings_approve();
alter table listings drop column if exists approve;
alter table listings drop column if exists approved_at;
alter table listings drop column if exists approved_hash;
alter table listings drop column if exists content_hash;
alter table listings drop column if exists unapproved_why;
