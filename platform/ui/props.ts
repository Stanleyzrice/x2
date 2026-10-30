// 组件参数里共用的几样（zod）：各组件的 schema.ts 引它。只有 zod，服务端照它校验，网页拿它的类型
import { z } from "zod";

export const title = z.string().trim().min(1).max(60).optional().describe("标题，短的一句；不给就不写");
