import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
	root: "apps/web",
	plugins: [react(), tailwind()],
	server: {
		port: 5173,
		proxy: { "/api": `http://127.0.0.1:${process.env.PORT || 4310}` },
	},
	build: { outDir: "../../dist-web", emptyOutDir: true },
});
