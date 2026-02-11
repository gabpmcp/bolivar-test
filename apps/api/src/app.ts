import express from "express";
import { registerCommandRoutes } from "./http/routes/command-routes.js";
import { registerQueryRoutes } from "./http/routes/query-routes.js";

export const createApp = () => {
  const app = express();
  app.use(express.json());

  registerCommandRoutes(app);
  registerQueryRoutes(app);

  return app;
};
