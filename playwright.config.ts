import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: "tests/e2e",
	fullyParallel: false,
	workers: 1,
	use: { baseURL: "http://127.0.0.1:4319", trace: "retain-on-failure" },
	webServer: {
		command: "bun scripts/e2e-server.ts",
		url: "http://127.0.0.1:4319/api/ready",
		reuseExistingServer: false,
		timeout: 120000,
	},
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] } },
		{
			name: "mobile",
			use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
		},
	],
});
