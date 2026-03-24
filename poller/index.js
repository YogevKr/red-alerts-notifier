import { createPollerConfig } from "./config.js";
import { createPollerApp } from "./poller-app.js";

async function main() {
  const app = createPollerApp(createPollerConfig(process.env));
  await app.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
