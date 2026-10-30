#!/bin/sh
# 给一个人开共享库的登录账号（密码随机），印出他 .env 里连库的两行，私下发给他；再跑一次是换密码。账号连进来当 x2 用（见 db-server.sh）。
# 删一个人：ssh -F ops/ssh_config penna-hk "cd /tmp && sudo -u postgres psql -c 'drop role <名字>'"
set -eu
name=${1:?用法：ops/db-user.sh <名字（小写字母、数字、下划线）>}
case $name in *[!a-z0-9_]* | x2 | postgres) echo "名字只能是小写字母、数字、下划线，不能是 x2、postgres" >&2 && exit 2 ;; esac
pw=$(openssl rand -hex 24)
cd "$(dirname "$0")"
printf '%s\n' \
	"select 'create role $name login in role x2' where not exists (select from pg_roles where rolname = '$name') \\gexec" \
	"alter role $name password '$pw';" \
	"alter role $name in database x2 set role = 'x2';" |
	ssh -F ssh_config penna-hk 'cd /tmp && sudo -u postgres psql -X -q -v ON_ERROR_STOP=1'
printf 'X2_DATABASE_URL=postgres://%s:%s@127.0.0.1:15432/x2\nX2_DATABASE_SSH=x2-db\n' "$name" "$pw"
