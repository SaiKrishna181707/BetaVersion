import { estimateCost, validateRunConfiguration, type RunDraft, type RunGateway } from '@centopus/contracts';

export const DRAFT_STORAGE_KEY = 'centopus:reviewed-draft:v1';
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A local adapter only. It cannot launch browsers, call AWS, or generate synthetic results. */
export function createLocalRunGateway(storage: DraftStorage, authorizedDomains: readonly string[]): RunGateway {
  return {
    async saveReviewedDraft(configuration) {
      const validation = validateRunConfiguration(configuration, authorizedDomains);
      if (!validation.ok) throw new Error('Review the highlighted configuration fields before saving.');
      const estimate = estimateCost(validation.value);
      if (estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) throw new Error('The estimate exceeds the configured budget.');
      const draft: RunDraft = {
        schema_version: 1, draft_id: crypto.randomUUID(), saved_at: new Date().toISOString(),
        mode: 'LOCAL_DRAFT', configuration: validation.value, estimate,
      };
      try { storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft)); }
      catch { throw new Error('This browser could not save the draft. Allow local storage and try again.'); }
      return draft;
    },
    async loadDraft() {
      let raw: string | null;
      try { raw = storage.getItem(DRAFT_STORAGE_KEY); }
      catch { throw new Error('Local storage is unavailable. You can configure a run, but saving may be unavailable.'); }
      if (!raw) return null;
      try {
        const data: unknown = JSON.parse(raw);
        if (!data || typeof data !== 'object') throw new Error();
        const draft = data as Partial<RunDraft>;
        if (draft.schema_version !== 1 || draft.mode !== 'LOCAL_DRAFT' || typeof draft.draft_id !== 'string'
          || typeof draft.saved_at !== 'string' || !Number.isFinite(Date.parse(draft.saved_at))) throw new Error();
        const validation = validateRunConfiguration(draft.configuration, authorizedDomains);
        if (!validation.ok) throw new Error();
        return { schema_version: 1, draft_id: draft.draft_id, saved_at: draft.saved_at, mode: 'LOCAL_DRAFT',
          configuration: validation.value, estimate: estimateCost(validation.value) };
      } catch { throw new Error('The saved draft is outdated or invalid. Start a new configuration below.'); }
    },
  };
}
