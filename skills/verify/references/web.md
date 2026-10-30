# 验网页

在真库的拷贝上开网页，用 `x2 shot` 经 booey 在人的 Chrome 里开一个 x2 自己的标签页截图，看截图、看报错。截完标签页自己关，不碰人的标签页。

## 开

```sh
node x2.ts web --scratch --port 5199
```

放后台跑（Claude Code 用后台命令；Codex、终端里末尾加 `&` 记下进程号）。它先复制真库、再打包界面，stderr 出「网页：http://127.0.0.1:5199」就好了；`x2 shot` 也会等它（最多 60 秒）。stderr 第一行是临时库的名字：要在拷贝上跑别的命令，把 `X2_DATABASE_URL` 的库名换成它。改了 `platform/ui` 要关掉重开（开的时候才打包）。

## 先查

`x2 browsers`：至少一个浏览器。退出码 3 是连不上 booey（daemon 没开、扩展没连上），请人处理。连着几个时 `x2 shot` 加 `--browser <名字或 id>`。

## 截

```sh
node x2.ts shot --url 'http://127.0.0.1:5199/#<页编号>' --out <你的临时目录>/verify-<页编号>.png
```

`#` 后面是页编号（`x2 page list`）。默认 1440×900，`--width`、`--height` 改；页长、组件在下面的加 `--height 4000`，一张截全。它从头加载、等网络静下来再截，回页面上的报错：`[console]` console.error，`[exception]` 没接住的异常，`[http]` 回了 >= 400 的请求，`[failed]` 连不上的请求。有报错退出码 1，截图照样存。

改之前先截一张（before），改完同样的页再截一张（after），两张都给人。截图放临时目录，不进仓库。

新组件、新的列在现有的页上没有：在拷贝上开一页放进去再截。`X2_DATABASE_URL=<临时库地址> node x2.ts page create --title 验证`，`page push` 放 `x2 page components` 里的例子。

## 看什么

- 没有报错（`x2 shot` 说「没有报错」）；说「网络还没静下来」的重截。
- 侧栏有页，标题对；改的那一处在截图里看得见、和 before 比只差该差的。
- 每个组件画出来了，不是空白、不是报错框：markdown 排好版；stats 有数字；diagram 是图，不是 mermaid 源码；chart 有轴、有柱或线；table、datagrid 有列名、有行，图加载出来。
- 现有的页覆盖了大部分组件：「知虾的数据」有 markdown、stats、diagram（erDiagram）、chart、table；「x2 的逻辑」有 markdown、stats、diagram（flowchart、stateDiagram）、datagrid（商品稿）。改了共用的部分两页都截。product、choice、chat 没在现有的页上，用上一节的办法放一个。
- 人在网页上的操作（改格、添一行、选了、生成回复）：`x2 shot` 不点，对临时库的服务发同样的请求（接口列在 `platform/web/server.ts` 开头），再截图看变化。

## 关

停掉 `x2 web` 的进程（Ctrl-C，或 `kill <进程号>`）：它输出「删了临时库 …」。被 `kill -9` 的临时库，下次 `--scratch` 开的时候删。截图留着。
