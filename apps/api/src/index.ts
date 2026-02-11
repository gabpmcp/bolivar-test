import { createApp } from "./app.js";
import { config } from "./config.js";

createApp().listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${config.port}`);
});
