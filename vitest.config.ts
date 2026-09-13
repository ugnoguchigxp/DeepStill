import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		react(),
		{
			name: "stub-css",
			transform(_code, id) {
				if (id.endsWith(".css"))
					return { code: "export default {}", map: null };
			},
		},
	],
	test: {
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		exclude: ["tests/e2e/**"],
		environment: "node",
		pool: "forks",
		fileParallelism: false,
		testTimeout: 60000,
		hookTimeout: 60000,
		setupFiles: ["tests/setup.ts"],
		coverage: {
			provider: "istanbul",
			reportsDirectory: "coverage",
			reporter: ["text", "html", "json-summary"],
			include: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
			exclude: ["**/*.d.ts"],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 80,
				statements: 80,
			},
		},
	},
});
