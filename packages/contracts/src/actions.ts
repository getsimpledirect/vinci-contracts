/**
 * The classes of consequential action that require approval by default
 * (FR-4.5).
 *
 * This lives in layer 0 because two packages need the same vocabulary for
 * different jobs, and a second copy would drift: `@getsimpledirect/vinci-policy` uses it to
 * write approval rules, and `@getsimpledirect/vinci-approvals` uses it to describe a pending
 * request without quoting free text.
 *
 * That second use is the load-bearing one. A push notification must carry no
 * secrets, no private code and no personal information (FR-5.4, SR-3), and the
 * only way to guarantee that is for the payload to contain nothing a human
 * typed. An enum member is authored here, in this file, by us — so a
 * notification built from it cannot leak what a request happened to say.
 */
export const CONSEQUENTIAL_ACTION_CLASSES = [
  "deployment",
  "production_database_change",
  "external_communication",
  "financial_obligation",
  "billing_modification",
  "content_publication",
  "customer_data_deletion",
  "access_control_change",
  "protected_branch_update",
  "infrastructure_purchase",
  "security_policy_change",
] as const;

export type ConsequentialActionClass = (typeof CONSEQUENTIAL_ACTION_CLASSES)[number];

/**
 * Fixed, human-readable text for each class, safe to put in a push payload.
 *
 * Authored here rather than derived from a request, which is the entire point:
 * every string a notification can contain is visible in this file.
 */
export const CONSEQUENTIAL_ACTION_LABELS: Readonly<Record<ConsequentialActionClass, string>> = {
  deployment: "deploy",
  production_database_change: "change a production database",
  external_communication: "send an external message",
  financial_obligation: "create a financial obligation",
  billing_modification: "change billing",
  content_publication: "publish content",
  customer_data_deletion: "delete customer data",
  access_control_change: "change access controls",
  protected_branch_update: "update a protected branch",
  infrastructure_purchase: "purchase infrastructure",
  security_policy_change: "change a security policy",
};

export function isConsequentialActionClass(value: unknown): value is ConsequentialActionClass {
  return (
    typeof value === "string" &&
    (CONSEQUENTIAL_ACTION_CLASSES as readonly string[]).includes(value)
  );
}
