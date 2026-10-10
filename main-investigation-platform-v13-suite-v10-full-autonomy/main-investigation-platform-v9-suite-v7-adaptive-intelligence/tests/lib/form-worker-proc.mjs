// The real Form Submitter platform worker (production start function, 3 s tick) as its own process.
// The reporting form is a synthetic Google Form: requests to docs.google.com/forms/d/e/TestLocal/ are
// redirected to FORM_TARGET (served by the test). Nothing reaches Google.
// Env: WORKER_DIR, MAIN_PLATFORM_URL, FORM_SUBMITTER_MODULE_KEY, FORM_TARGET.
process.chdir(process.env.WORKER_DIR);
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => String(url).startsWith('https://docs.google.com/forms/d/e/TestLocal/') ? realFetch(process.env.FORM_TARGET, options) : realFetch(url, options);
const {durableStorage, startPlatformReportWorker} = await import(new URL('../../integrations/form-submitter/server/integration/platform_worker.ts', import.meta.url));
const at = new Date().toISOString(), formUrl = 'https://docs.google.com/forms/d/e/TestLocal/viewform', version = process.env.FORM_VERSION ?? 'v1';
durableStorage.syncFullState({settings: {username: 'e2e-analyst', teamInviteCode: 'e2e-code', autoSubmitGlobalEnabled: true},
  formConfig: {formUrl, formId: 'TestLocal', formTitle: 'Synthetic report form', formVersionHash: version, verifiedAt: at,
    parsedSchema: {formId: 'TestLocal', formTitle: 'Synthetic report form', formUrl, versionHash: version, sections: [], parsedAt: at,
      allQuestions: [{id: '1', entryKey: 'entry.1', title: 'Site URL', type: 'SHORT_ANSWER', required: true, pageIndex: 1}, {id: '2', entryKey: 'entry.2', title: 'Wallets', type: 'PARAGRAPH', required: true, pageIndex: 1}]},
    fieldMappings: [{id: 'site', fieldKey: 'siteUrl', label: 'Site URL', entryKey: 'entry.1', pageIndex: 1, required: true}, {id: 'w', fieldKey: 'walletsList', label: 'Wallets', entryKey: 'entry.2', pageIndex: 1, required: true}],
    multiWalletFormat: 'COMBINED_LIST'}});
await startPlatformReportWorker();
console.log('WORKER_READY');
