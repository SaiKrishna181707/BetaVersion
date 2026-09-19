/**
 * The evidence builder moved to `@synthetic-beta/contracts` so the AWS finalizer and the local
 * orchestrator cannot classify the same trace differently. This module re-exports it.
 */
export { buildSessionEvidence, type BuildSessionEvidenceInput } from '@synthetic-beta/contracts';