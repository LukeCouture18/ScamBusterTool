/**
 * Execution guard for replay and simulation.
 *
 * Code that runs inside `withoutExecution()` can read anything but can never
 * cause an external or state-changing action: every executor on the platform
 * (module job creation, investigator start, campaign creation, graph edge and
 * hypothesis writes, work-item execution) calls `assertExecutionAllowed()`
 * first, and it throws inside a guarded scope. The scope follows async calls
 * (AsyncLocalStorage), so it cannot be escaped by awaiting.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Scope = { reason: string; blocked: string[] };
const storage = new AsyncLocalStorage<Scope>();

export class ExecutionBlocked extends Error {
  constructor(readonly action: string, readonly reason: string) { super(`EXECUTION_BLOCKED:${action}:${reason}`); }
}

export function withoutExecution<T>(reason: string, fn: () => Promise<T>): Promise<{ value: T; blocked: string[] }> {
  const scope: Scope = { reason, blocked: [] };
  return storage.run(scope, async () => ({ value: await fn(), blocked: scope.blocked }));
}

export function executionBlocked() { return storage.getStore() ?? null; }

export function assertExecutionAllowed(action: string) {
  const scope = storage.getStore();
  if (scope) { scope.blocked.push(action); throw new ExecutionBlocked(action, scope.reason); }
}
