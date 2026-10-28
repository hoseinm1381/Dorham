import { createApp } from './app';
const { app, config } = await createApp();
await app.listen({ port: config.port, host: config.host });
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => { void app.close().then(() => process.exit(0)); });
