-- Chat 的不可变上下文、人工草稿、建议及请求意图。凭证和模型token不落库。
create table if not exists chat_contexts (
 id text primary key, shop text not null, shop_id text not null, conversation_id text not null,
 context_hash text not null, data jsonb not null, created_at timestamptz not null default now(),
 unique (shop, shop_id, conversation_id, context_hash)
);
create table if not exists chat_drafts (
 shop text not null, shop_id text not null, conversation_id text not null,
 text text not null, revision int not null default 1, updated_at timestamptz not null default now(),
 primary key(shop, shop_id, conversation_id)
);
create table if not exists chat_suggestions (
 id text primary key, shop text not null, shop_id text not null, conversation_id text not null,
 context_id text not null references chat_contexts(id), context_hash text not null,
 latest_buyer_id text, text text not null, model text not null, created_at timestamptz not null default now()
);
create table if not exists chat_intents (
 request_id text primary key, shop text not null, shop_id text not null, conversation_id text not null,
 input jsonb not null, context_id text not null references chat_contexts(id),
 claimed boolean not null default false, submission_started boolean not null default false,
 created_at timestamptz not null default now()
);
create index if not exists chat_suggestions_thread on chat_suggestions(shop, shop_id, conversation_id, created_at desc);
create table if not exists chat_inbox_snapshots (
 shop text not null, shop_id text not null, days int not null, data jsonb not null,
 primary key(shop, shop_id, days)
);
