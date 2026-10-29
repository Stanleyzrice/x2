// markdown：一段话（标题、列表、表格、链接）。链接在新窗口开
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Props } from "../../web/sessions.ts";

export function Markdown({ props }: { props: Props<"markdown"> }) {
	return (
		<div className="markdown text-sm leading-relaxed">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}>
				{props.text}
			</ReactMarkdown>
		</div>
	);
}
