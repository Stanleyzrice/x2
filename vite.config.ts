// 网页的界面（web/ui/）：x2 web 打包进 web/ui/dist 再发；@/ 指 web/ui/（shadcn 的组件这样引）

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web/ui",
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./web/ui", import.meta.url)) } },
	build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
