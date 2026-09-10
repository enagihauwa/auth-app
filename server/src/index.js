import app from "./app.js";
import { config } from "./config.js";
import { startWorker } from "./processing/worker.js";

startWorker();

app.listen(config.port, () => {
  console.log(`Auth API listening on http://localhost:${config.port}`);
});