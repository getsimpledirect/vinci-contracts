const m = await import("/private/tmp/claude-501/-Users-georgepu-projects/abba1454-a4c1-4597-8fa7-b65a01049117/scratchpad/wt35/packages/model-classes/dist/index.js");
const role = { schemaVersion:1, roleId:"r", taskClass:"t", requiredCapabilities:[], minimumContextTokens:1000,
  riskClass:"low", dataPolicy:{externalProviderAllowed:true,outputRetentionAllowed:true,processesProtectedData:false},
  qualityPolicy:{minimumVerifiedSuccessRate:0.7,maximumFalseClaimRate:0.02},
  economicPolicy:{maximumCostPerVerifiedSuccessUsd:20,maximumP95WallSeconds:7200}, fallbackRoleIds:[] };
// Proxy over a real Array: length says 1, iterator yields forever
const evil = new Proxy([{}], { get(t,k){ if(k==="length") return 1;
  if(k===Symbol.iterator) return function*(){ for(;;) yield {}; }; return t[k]; } });
const t0=Date.now();
try { const r = m.selectForRole(role, evil, "2026-08-31T00:00:00.000Z");
  console.log("proxy-iterator ->", Date.now()-t0,"ms, buckets:", r.eligible.length, r.unevaluable.length, r.ineligible.length);
} catch(e){ console.log("threw:", e.message.slice(0,60)); }
const huge = Object.assign([], {length: 2**32-1});
const r2 = m.selectForRole(role, huge, "2026-08-31T00:00:00.000Z");
console.log("huge array -> unevaluable entries:", r2.unevaluable.length, "reason:", r2.unevaluable[0]?.reasons?.[0]?.code);
