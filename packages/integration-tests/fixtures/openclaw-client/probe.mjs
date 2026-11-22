import { readFileSync } from 'node:fs';
import { GadgetClient } from './core.mjs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
try {
  const client = new GadgetClient(config);
  const result = await client.call('fixture', {instance:'local', gadget:'weather', operation:'snapshot', input:{}});
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.code ?? 'CLIENT_FAILED');
  process.exitCode = 1;
}
