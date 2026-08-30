import "./config/env.js";
import { SyncServer } from "./server.js";

try {
  const syncServer = new SyncServer();
  syncServer.start();
} catch (error) {
  console.error(error);
  process.exit();
}