#!/bin/sh
# 在香港服务器上装共享库，跑几遍都一样。Postgres 15（和本机 pg_dump 一个版本，x2 web --scratch 要用它复制库），只听服务器自己的 5432，各人经 SSH 隧道连（ssh_config 的 x2-db）。
# 库 x2 归不能登录的角色 x2；每人的登录账号（db-user.sh 建）连进来都当 x2 用，谁先建表、加列都一样。每天 4 点 pg_dump 到服务器的 /var/backups/x2，留 14 天
set -eu
cd "$(dirname "$0")"
ssh -F ssh_config penna-hk 'sudo sh -s' <<'EOF'
set -eu
cd /tmp
if ! pg_lsclusters 2>/dev/null | grep -q '^15 '; then
	DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql-common
	/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
	DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql-15
fi
sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
select 'create role x2 nologin createdb' where not exists (select from pg_roles where rolname = 'x2') \gexec
select 'create database x2 owner x2' where not exists (select from pg_database where datname = 'x2') \gexec
SQL
install -d -o postgres -m 700 /var/backups/x2
cat > /etc/cron.d/x2-backup <<'CRON'
0 4 * * * postgres pg_dump -Fc -d x2 -f /var/backups/x2/x2-$(date +\%F).dump && find /var/backups/x2 -name 'x2-*.dump' -mtime +14 -delete
CRON
pg_lsclusters
EOF
