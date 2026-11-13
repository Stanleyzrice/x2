// 网页的界面：x2 web 打包进 platform/ui/dist 再发；@/ 指 platform/ui/（shadcn 的组件这样引）

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const resolve = { alias: { "@": root } };

export default defineConfig({
	root,
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "x2-collection-ui",
			apply: "build",
			// 采集浮层复用本项目组件并打成自包含脚本，经 CDP 注入，平台页无需请求本机 HTTP 资源。
			async closeBundle() {
				await build({
					configFile: false,
					root,
					plugins: [react(), tailwindcss()],
					resolve,
					logLevel: "warn",
					define: { "process.env.NODE_ENV": JSON.stringify("production") },
					build: {
						outDir: "dist",
						emptyOutDir: false,
						cssCodeSplit: false,
						lib: {
							entry: `${root}/browser-collection.tsx`,
							name: "X2CollectionUI",
							formats: ["iife"],
							fileName: () => "collection-ui.js",
							cssFileName: "collection-ui",
						},
					},
				});
			},
		},
	],
	resolve,
	build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
