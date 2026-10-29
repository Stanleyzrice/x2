// 全部 toolkit：平台的命令和会话、站点、服务、skill。bin/x2.ts 把它们注册进平台；测试照它注册
import { gemini } from "../connectors/services/gemini/index.ts";
import { image } from "../connectors/services/image/index.ts";
import { market } from "../connectors/services/market/index.ts";
import { xiangji } from "../connectors/services/xiangji/index.ts";
import { alibaba } from "../connectors/sites/1688/index.ts";
import { chanboss } from "../connectors/sites/chanboss/index.ts";
import { shopee } from "../connectors/sites/shopee/index.ts";
import { zhixia } from "../connectors/sites/zhixia/index.ts";
import { platform, session } from "../platform/commands.ts";
import type { Toolkit } from "../platform/tool.ts";
import { listing } from "../skills/listing/index.ts";
import { orders } from "../skills/orders/index.ts";
import { selection } from "../skills/selection/index.ts";

export const TOOLKITS: Toolkit[] = [platform, session, orders, listing, selection, shopee, alibaba, chanboss, zhixia, market, gemini, xiangji, image];
