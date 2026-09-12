import { Store } from "../../packages/db";
const store = new Store(process.argv[2]);
const t = store.claim(Number(process.argv[3] || 30000));
console.log(JSON.stringify(t));
if (process.argv[4] === "hold") await Bun.sleep(60000);
store.close();
