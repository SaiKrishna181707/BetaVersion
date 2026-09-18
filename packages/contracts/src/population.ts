import type { SyntheticPersona } from './model';

export type TechnicalAbility = SyntheticPersona['technical_ability'];
export type ProductFamiliarity = SyntheticPersona['product_familiarity'];
export type PatienceLevel = SyntheticPersona['patience'];
export type ReadingStyle = SyntheticPersona['reading_style'];
export type DeviceClass = SyntheticPersona['device_class'];
export type Sensitivity = NonNullable<SyntheticPersona['price_sensitivity']>;

/** Relative weights per trait value. Omitted values fall back to an equal share. */
export type TraitMix<T extends string> = Partial<Record<T, number>>;

/**
 * Deterministic inputs for a synthetic population. The same spec always produces the
 * same cohort, so a run can be replayed and reviewed against an identical population.
 */
export interface PopulationSpec {
  population_seed: string;
  cohort: string;
  goal_context: string;
  size: number;
  device_class_mix?: TraitMix<DeviceClass>;
  technical_ability_mix?: TraitMix<TechnicalAbility>;
  patience_mix?: TraitMix<PatienceLevel>;
}

/** Counts traits across a built cohort. Computed by the population service, rendered by the UI. */
export interface CohortProfile {
  cohort: string;
  size: number;
  technical_ability: Record<TechnicalAbility, number>;
  patience: Record<PatienceLevel, number>;
  device_class: Record<DeviceClass, number>;
}