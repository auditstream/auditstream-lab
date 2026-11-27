import { serve } from "@hono/node-server";
import { startLabServer } from "../../shared/http.js";
import { createApp } from "./app.js";
import { createPrismaDatabase } from "./db.js";

startLabServer({
  appName: "prisma-api",
  defaultPort: 3102,
  createHandle: createPrismaDatabase,
  createAppFetch: (handle) => createApp(handle).fetch,
  startServer: (fetch, port, onListening) =>
    serve({ fetch, hostname: "127.0.0.1", port }, (info) => onListening(info.port)),
});
