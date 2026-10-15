import { createApp } from './app';
import { config } from './config';
import { migrate } from './migrate';

async function main(): Promise<void> {
  await migrate();
  createApp().listen(config.port, () => {
    console.log(`backend listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('startup failed', err);
  process.exit(1);
});
