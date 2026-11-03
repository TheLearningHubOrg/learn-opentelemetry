import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);

createApp().listen(port, () => {
  console.log(`checkout-service listening on http://localhost:${port}`);
});
