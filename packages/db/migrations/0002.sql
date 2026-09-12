CREATE TABLE research_work_items(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),round_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,next_at INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX research_work_ready ON research_work_items(job_id,round_id,status,next_at,priority);
CREATE TABLE execution_slot(id INTEGER PRIMARY KEY CHECK(id=1),owner_token TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,job_id TEXT,operation_key TEXT,state TEXT NOT NULL DEFAULT 'idle');
INSERT INTO execution_slot(id) VALUES(1);
