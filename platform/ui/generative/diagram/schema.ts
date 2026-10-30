// diagram 的参数：一张 Mermaid 图
import { z } from "zod";
import { title } from "../../props.ts";

export const description =
	'一张图（Mermaid 的文字）：流程（flowchart）、状态怎么走（stateDiagram-v2）、谁调谁（sequenceDiagram）、表和关系（erDiagram）。节点的字有标点、空格的加引号，例 A["x2 status"]';
export const props = z.strictObject({ title, mermaid: z.string().trim().min(1) });
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [{ mermaid: 'flowchart LR\n  A["x2 status"] --> B["人批准"] --> C["写入"]' }];
