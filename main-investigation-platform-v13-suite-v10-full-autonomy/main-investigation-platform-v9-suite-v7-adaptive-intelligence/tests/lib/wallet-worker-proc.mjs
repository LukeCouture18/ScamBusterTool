// The real Wallet Investigator platform worker as its own process, so tests can kill and restart it.
// Env: WORKER_DIR (its data directory), MAIN_PLATFORM_URL, WALLET_INVESTIGATOR_MODULE_KEY,
// WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES=1 (no real chain provider is contacted).
process.chdir(process.env.WORKER_DIR);
const worker = await import(new URL('../../integrations/wallet-investigator/server/integration/platform_worker.ts', import.meta.url));
await worker.startPlatformWorker();
console.log('WORKER_READY');
