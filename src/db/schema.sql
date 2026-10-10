-- 库的结构。x2 每个进程第一次用库时跑一遍：只建没有的表、加没有的列，所以每一句都要能重复跑。
-- 表建好以后再加列：不改 create table，在最后「加列」一节写 alter table … add column if not exists（已有的库里 create table 不会再跑）。
-- 表名、列名用英文（NocoDB 里显示中文）；给人看的值（类别、状态）用中文，NocoDB 里直接能读。
--
-- 只存三类（docs/loop.md「怎样工作」）：站点上没有的（人的决定、设置）；写入的记录；给团队在 NocoDB 里看的（订单的进度）。
-- 站点上有的（购物车、采购单、1688 商品详情、店里的商品、登录着的账号）不存：每次 x2 status 经浏览器现读。

-- ── 设置 ──

-- 订单设置：只有一行
create table if not exists order_settings (
	id int primary key default 1 check (id = 1),
	-- 采购账号（1688 会员名）：只有一个账号做采购，x2 只往它加购，别的 1688 账号只读。换账号改这一格
	buy_account text,
	-- 离出货期限不到几天、还没打包，就进收件箱给人
	late_days int not null default 6,
	-- 未发货提醒：1688 付款后多少小时还没发货，就进收件箱给人
	ship_wait_hours int not null default 48,
	forecast_needs_approval boolean not null default true,
	-- 发货线路：海快（chanboss 的 sendway_id 752）。line_id、warehouse_id 是 chanboss 上这条线路的线路和仓库（2026-10-09 读已预报的订单：1111、5176）
	channel text not null default '海快',
	sendway_id int not null default 752,
	line_id int not null default 1111,
	warehouse_id int not null default 5176
);
insert into order_settings (id) values (1) on conflict do nothing;

-- ── 人的决定 ──

-- 货源：一行是「店里一个商品 × 一个货源」。一个商品只用一个货源（chosen：选用，一个商品最多一行）；没 chosen 的是还在挑的。
-- 规格不存对应：加购时按店里的规格名，在货源的规格里配。
-- 货源的样子（标题、图、规格和价格）存一份快照：下架了还知道原来买的是什么，好比价、好在 NocoDB 里看图挑。x2 每次现读这个货源就更新快照；买之前一律现读，不信快照
create table if not exists sources (
	item_id text not null,
	-- 货源在哪个站、站上的 id：现在都是 1688
	site text not null default '1688',
	offer_id text not null,
	-- 店里的商品（给人看）
	item_name text,
	item_image text,
	-- 快照：链接、标题、图、规格 [{ skuId, specId, name, price, stock, image }]、什么时候读的
	url text,
	title text,
	image text,
	skus jsonb not null default '[]',
	read_at timestamptz,
	-- 相似度：店里卖过的规格有几成在这个货源里对得上；missing 是未匹配的规格
	score numeric,
	missing text,
	-- 来源：以图搜图、人工添加、原有
	origin text,
	-- 明显匹配：x2 认为明显对得上（卖过的规格都对得上，而且只有它对得上），随加购一起批准，不进收件箱
	sure boolean not null default false,
	chosen boolean not null default false,
	-- 不可用：选用的货源下架时 x2 现读发现，写原因；检查当成缺货源
	broken text,
	found_at timestamptz not null default now(),
	chosen_at timestamptz,
	primary key (item_id, offer_id)
);
create unique index if not exists sources_chosen on sources (item_id) where chosen;

-- 到货问题：错货、少件、损坏。x2 看不到，人在 NocoDB 的表单里上报（订单号、商品和规格、问题类型、件数），处理完勾「已处理」。
-- 未处理的：订单停在「有到货问题」，不提醒打包；收件箱一行一个问题
create table if not exists arrival_issues (
	id bigserial primary key,
	sn text not null,
	item text,
	kind text not null default '损坏',
	qty int,
	note text,
	-- 处理方式：退换、重新采购、无需处理
	resolution text,
	done boolean not null default false,
	reported_at timestamptz not null default now(),
	done_at timestamptz
);

-- ── 收件箱和写入 ──

-- 收件箱：一件要人做的事。key 是「类别:对象」，每轮重算，只更新不重复；条件不成立就关。
-- 人只改 approve（批准）、done（已处理：x2 看不到结果的事，勾了就关、不再开）、snooze_until（推迟至）、note。role 是负责人（现在都是运营）
create table if not exists inbox (
	key text primary key,
	kind text not null,
	title text not null,
	detail text,
	role text not null default '运营',
	shop text,
	due timestamptz,
	link text,
	approve boolean,
	done boolean not null default false,
	open boolean not null default true,
	snooze_until timestamptz,
	note text,
	opened_at timestamptz not null default now(),
	closed_at timestamptz,
	updated_at timestamptz not null default now()
);

create sequence if not exists batch_seq;

-- 写入：做了一次写操作。先记意图（已提交），再提交一次，再读回来
-- status：待批准、已批准、已提交、成功、被拒、结果未知、已核对、不一致、未执行
create table if not exists writes (
	id bigserial primary key,
	batch bigint not null,
	op text not null,
	target text not null,
	params jsonb not null,
	display text,
	-- 防重复：同一个 key 已有成功、结果未知……的写入，不再提交
	key text not null,
	-- 执行（include）：人在批准前取消勾，这一项不做
	include boolean not null default true,
	status text not null default '待批准',
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

-- ── 给团队看的 ──

-- 订单：每次 x2 status 现读 chanboss 的订单列表（两家店都在）以后整份重写，加上检查算出来的列。给不在开着浏览器的那台电脑前的人看进度（待出货看板），不当真相用
create table if not exists orders (
	sn text primary key,
	shop text,
	shop_id text,
	created_at timestamptz,
	ship_by timestamptz,
	platform_status text,
	chanboss_status text,
	-- chanboss 上这张订单的 id、下单时间（秒）：预报要带
	chanboss_id text,
	chanboss_time bigint,
	-- 商品：[{ itemId, modelId, chanbossModelId, name, spec, qty, image }]
	items jsonb not null default '[]',
	items_text text,
	-- chanboss 标的问题（没有是 null）
	problem text,
	cancelled_at timestamptz,
	-- 检查算出来的
	days_left numeric,
	destination text,
	step text,
	step_detail text,
	checked_at timestamptz
);

-- ── 上品（docs/listing.md） ──

-- 店铺设置：一家店一行，人定的：核价参数、上品的默认值、允许的类目、水印、暂停上品。在 NocoDB 里改；比例在 0–1、汇率大于 0，填错存不进
-- 核价参数的默认值是 lilto 的 landed-cost.json（2026-09-02 依账单和结算截图定）
create table if not exists shop_settings (
	shop text primary key,
	-- Shopee 的店铺 id：x2 按它找这家店的浏览器（不是卖家账号 id，两个不一样）
	shop_id text not null unique,
	-- 核价（docs/listing.md「核价」）
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

-- 商品稿：一个货源 × 一家店。x2 做（读货源、类目属性、规格和价格、图），agent 写标题和描述，人在 NocoDB 里审稿。
-- 人改：标题、描述、重量、国内运费、放弃（cancelled）、备注、策略；主图、详情图（删掉的那张就不要了）
create table if not exists listings (
	id bigserial primary key,
	shop text not null,
	-- 1688 的货源 id（人在 NocoDB 表单里贴整个链接也行，x2 做商品稿时改成 id）
	offer_id text not null,
	-- 从哪个策略来（现在都是人选的）：以后按策略看效果
	strategy text not null default '人选',
	cancelled boolean not null default false,
	-- 人工填写：1688 没给重量时，每个规格都用它（kg）；国内运费（元 / 件）：货源包邮自动是 0，不知道就空着
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
	-- 规格：[{ sku, skuId, specId, specs, costRmb, weightKg, stock, image, priceTwd }]
	variants jsonb not null default '[]',
	variants_text text,
	-- 图：{ main: [...], detail: [...], options: {...}, sizeChart }，每张 { from（原图地址）, sha（原图）, final（成品）, imageId, width, height, verdict }
	images jsonb not null default '{}',
	-- 给人在 NocoDB 里看、删的图：NocoDB 的附件（JSON 文本，[{ url: Shopee 的图片地址, title, mimetype }]）；人删了哪张，x2 记进 removed_images
	main_images text,
	detail_images text,
	-- 核价用的参数快照
	pricing jsonb,
	-- 台湾成品审核（Gemini）
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

-- 策略：选品的一个做法（docs/listing.md「策略」）。agent 定、做实验（explore / exploit）；商品稿的 strategy 写它的名字
create table if not exists strategies (
	name text primary key,
	-- 假设：押的是什么
	bet text,
	-- 选品方法：看什么数据、什么条件、去哪找货源
	how text,
	status text not null default '试验中' check (status in ('试验中', '使用中', '已停用')),
	note text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
-- 状态的约束：先去掉，把旧取值（在用、停了）换成现在的，再加回来
alter table strategies drop constraint if exists strategies_status_check;
update strategies set status = case status when '在用' then '使用中' else '已停用' end where status in ('在用', '停了');
alter table strategies add constraint strategies_status_check check (status in ('试验中', '使用中', '已停用'));
insert into strategies (name, bet, how, status) values ('人选', '人挑的货源', '运营贴链接', '使用中') on conflict do nothing;

-- ── 加列（表建好以后加的列写在这里） ──

-- 规格例外：店里的规格按名字在货源的规格里配不上时，人定的。一行一个「店里的规格名 = 货源的规格名」（单规格写「（单规格）」）；
-- 只记例外，配得上的不记。人在 NocoDB 里写，或者人在终端里说了、agent 用 x2 source <商品 id> --spec 写。换了货源就跟着那一行删掉
alter table sources add column if not exists sku_exceptions text;

-- 已删除的图（Shopee 的图片 id）：人在 NocoDB 的「主图」「详情图」里删了附件，x2 记在这里，再做商品稿也不用它
alter table listings add column if not exists removed_images jsonb not null default '[]';
-- 已移除的规格（货号，例 店里接不了的「定製」）：人说了，agent 用 x2 listing drop 写；再做商品稿也不要它
alter table listings add column if not exists removed_variants jsonb not null default '[]';
-- 保留的图（Shopee 的图片 id）：台湾成品审核挑出、人看过说要用的图（人说了，agent 用 x2 listing audit --accept 写）；以后审核再挑它也不挡
alter table listings add column if not exists kept_images jsonb not null default '[]';
-- 商品稿的店铺不用外键（NocoDB 会把外键变成关联列，表单里就不能直接选店）；x2 做商品稿时核对店铺设置里有没有这家店
alter table listings drop constraint if exists listings_shop_fkey;
-- NocoDB 的附件是 JSON 文本（它写回来的也是文本）
alter table listings alter column main_images type text using main_images::text;
alter table listings alter column detail_images type text using detail_images::text;
-- 到货问题的类型默认「损坏」
alter table arrival_issues alter column kind set default '损坏';
