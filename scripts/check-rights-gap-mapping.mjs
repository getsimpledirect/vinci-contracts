#!/usr/bin/env node
import assert from "node:assert/strict";
import { mapUnevaluableReason } from "./rights-gap-mapping.mjs";

assert.deepEqual(
  mapUnevaluableReason(
    {
      code: "rights_undeclared",
      detail: "high-risk role requires trainingAllowed to be declared",
    },
    { provider: "openrouter" },
  ),
  {
    field: "trainingAllowed",
    document: "OpenRouter terms of service",
  },
);

assert.deepEqual(
  mapUnevaluableReason(
    { code: "future_undeclared_reason", detail: "new matcher reason" },
    { endpointId: "endpoint-1" },
  ),
  {
    field: "unmapped:future_undeclared_reason",
    document: "matcher/report mapping audit",
  },
);

console.log("rights-gap mapping checks passed");
