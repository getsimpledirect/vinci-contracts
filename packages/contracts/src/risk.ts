/** Shared closed vocabulary for qualitative risk levels and severities. */
export const RISK_LEVELS = ["critical", "high", "medium", "low"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
