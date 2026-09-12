import { Store } from "../packages/db";
const store = new Store();
store.migrate();
store.close();
console.log("Database migration 1 applied.");
