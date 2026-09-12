import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const records = sqliteTable("records", {
	jobId: text("job_id").notNull(),
	kind: text("kind").notNull(),
	id: text("id").notNull(),
	data: text("data").notNull(),
});
export const events = sqliteTable("events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	jobId: text("job_id").notNull(),
	type: text("type").notNull(),
	data: text("data").notNull(),
	createdAt: integer("created_at").notNull(),
});
