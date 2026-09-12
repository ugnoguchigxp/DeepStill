import { Store } from "../../packages/db";
const store = new Store(process.argv[2]);
const task = store.claim(30000, process.argv[3]);
const acquired = task ? store.acquireSlot(task) : false;
if (acquired && task) {
	if (process.argv[4] === "unknown") store.markExternal(task, "in_flight");
	console.log(JSON.stringify({ acquired, task }));
	await Bun.sleep(1000);
	if (process.argv[4] !== "unknown") store.releaseSlot(task);
} else console.log(JSON.stringify({ acquired: false }));
store.close();
