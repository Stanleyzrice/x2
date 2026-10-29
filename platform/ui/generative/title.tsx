// generative 组件的标题（给了才有）
export function Title({ children }: { children?: string | undefined }) {
	return children ? <h3 className="mb-2 text-sm font-medium">{children}</h3> : null;
}
