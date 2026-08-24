/**
 * Shared closed vocabulary for qualitative risk levels and severities.
 *
 * ORDERED MOST SEVERE FIRST, and that ordering is load-bearing information even
 * though nothing reads it positionally today.
 *
 * This list existed twice with OPPOSITE orderings: approvals declared
 * ["critical","high","medium","low"] and evidence declared
 * ["low","medium","high","critical"]. Same four members, reversed. That is worse
 * than an exact duplicate — two lists agreeing on membership and disagreeing on
 * position give opposite answers the moment anything sorts, indexes or compares
 * by ordinal, and neither side looks wrong in isolation.
 *
 * Unifying them necessarily picked one order, which REVERSED evidence's. That
 * was safe only because both packages used the list purely for `.includes()`
 * membership. The test beside this file pins the order so a later positional use
 * cannot silently inherit the old ascending assumption.
 *
 * If you add a member, put it in severity order. If you need an ordinal
 * comparison, index into THIS array and say so at the call site.
 */
export const RISK_LEVELS = ["critical", "high", "medium", "low"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
