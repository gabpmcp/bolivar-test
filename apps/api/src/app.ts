import express from "express";
import { registerRoutes } from "./http/routes/routes.js";

export const createApp = () => {
  const app = express();
  app.use(express.json());

  registerRoutes(app);

  return app;
};
