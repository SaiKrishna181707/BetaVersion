/**
 * The run-start bookkeeping moved to `@synthetic-beta/contracts` so the local and AWS runtimes
 * record a run identically. This module re-exports it.
 */
export { beginRun, failRun } from '@synthetic-beta/contracts';