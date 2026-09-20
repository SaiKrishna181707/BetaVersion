import { invokeNovaJson, type JsonModel } from '@centopus/ai';
import type { CentopusReport, SyntheticPersona } from '@centopus/contracts';

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** Refines presentation only. Recorded outcomes, metrics, evidence and confidence remain immutable. */
export async function refineReportWithNova(
  report: CentopusReport,
  personas: readonly SyntheticPersona[],
  model: JsonModel = invokeNovaJson,
  modelId = process.env.NOVA_REPORT_MODEL_ID || 'amazon.nova-micro-v1:0',
): Promise<CentopusReport> {
  const personaById = new Map(personas.map(persona => [persona.persona_id, persona]));
  const chunks = Array.from({ length: Math.ceil(report.agent_feedback.length / 20) }, (_, index) =>
    report.agent_feedback.slice(index * 20, index * 20 + 20));
  const refined = await Promise.all(chunks.map(async feedbackChunk => model<{ feedback?: Record<string, unknown>[] }>({
    modelId,
    system: 'Edit synthetic usability feedback for clarity and natural variety. Return valid JSON only. Never add an action, fact, feeling, or success not present in the supplied evidence-derived draft.',
    prompt: `Rewrite each draft in a distinct voice appropriate to the persona. Failed, timed-out, abandoned, and zero-evidence sessions must stay negative, incomplete, or explicitly inconclusive. Do not mention infrastructure, APIs, models, automation errors, or system internals. Discuss only the product experience that the evidence supports. Do not reuse a sentence across agents.

Return {"feedback":[{"session_id","direct_feedback","feeling_summary","expectation_gap","task_confidence_reason","would_use_again_reason","improvement_suggestion"}]}.

Drafts:\n${JSON.stringify(feedbackChunk.map(item => ({
      session_id: item.session_id,
      immutable_outcome: report.agent_results.find(result => result.session_id === item.session_id),
      immutable_feeling: item.overall_feeling,
      immutable_confidence: item.task_confidence,
      evidence_event_count: item.evidence_event_count,
      persona: personaById.get(item.persona_id),
      draft: item,
    })))}`,
    maxTokens: Math.min(8000, 900 + feedbackChunk.length * 300),
    temperature: 0.55,
  })));

  const edits = new Map<string, Record<string, unknown>>(refined
    .flatMap((result: { feedback?: Record<string, unknown>[] }) => Array.isArray(result.feedback) ? result.feedback : [])
    .filter((item: Record<string, unknown>) => typeof item.session_id === 'string')
    .map((item: Record<string, unknown>) => [item.session_id as string, item]));
  const directSignatures = new Set<string>();
  const agent_feedback = report.agent_feedback.map(item => {
    const edit = edits.get(item.session_id);
    if (!edit) return item;
    const direct = bounded(edit.direct_feedback, 1200);
    if (!direct || directSignatures.has(direct.toLowerCase())) return item;
    directSignatures.add(direct.toLowerCase());
    return {
      ...item,
      direct_feedback: direct,
      feeling_summary: bounded(edit.feeling_summary, 900) || item.feeling_summary,
      expectation_gap: bounded(edit.expectation_gap, 900) || item.expectation_gap,
      task_confidence_reason: bounded(edit.task_confidence_reason, 700) || item.task_confidence_reason,
      would_use_again_reason: bounded(edit.would_use_again_reason, 700) || item.would_use_again_reason,
      improvement_suggestion: bounded(edit.improvement_suggestion, 700) || item.improvement_suggestion,
    };
  });
  return { ...report, agent_feedback };
}
