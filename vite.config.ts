// 网页的界面（web/）：x2 web 打包进 web/dist 再发

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ root: "web", plugins: [react(), tailwindcss()], build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 } });
