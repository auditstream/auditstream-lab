import { serve } from "@hono/node-server";
import { startLabServer } from "../../shared/http.js";
import { createApp } from "./app.js";
import { createDatabase } from "./db.js";

startLabServer({
  appName: "hono-drizzle",
  defaultPort: 3101,
  createHandle: createDatabase,
  createAppFetch: (handle) => createApp(handle).fetch,
  startServer: (fetch, port, onListening) =>
    serve({ fetch, hostname: "127.0.0.1", port }, (info) => onListening(info.port)),
});
