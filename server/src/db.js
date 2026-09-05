import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});