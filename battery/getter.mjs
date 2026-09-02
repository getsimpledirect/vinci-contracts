const m = await import("/private/tmp/claude-501/-Users-georgepu-projects/abba1454-a4c1-4597-8fa7-b65a01049117/scratchpad/wt35/packages/model-classes/dist/index.js");
const base = (id, cls, wd) => ({ schemaVersion:1, endpointId:id, capabilityProfile:{capabilities:["text"],contextLimit:1000,toolSupport:false},
  declaredCapabilities:[], credentials:{source:{kind:"managed-credential",credentialId:"c"}},
  inferenceIsExternal:{kind:"known",value:false}, approvedForProtectedData:{kind:"known",value:false},
  rights:{trainingAllowed:{kind:"known",value:false},evaluationAllowed:{kind:"known",value:false},
    redistributionAllowed:{kind:"known",value:false},outputRetainedByProvider:{kind:"known",value:false},
    policySnapshotDigest:{kind:"known",value:"d"}},
  validFrom:"2026-01-01T00:00:00.000Z", expiresAt:"2027-01-01T00:00:00.000Z",
  sourceClass:cls, weightsDigest:wd, tokenizerDigest:"t", architectureDigest:"a",
  servingImageDigest:{kind:"known",value:"i"}, quantizationDigest:{kind:"unknown"} });

// SAME weights, same class -> must be a violation (true)
const honest = base("p","open_weight","SHARED");
console.log("honest same-weights pair ->", m.violatesIndependence(honest, base("r","open_weight","SHARED")));

// attacker: sourceClass legible on read 1, DIFFERENT on read 2
let n = 0;
const sneaky = { ...base("p","open_weight","SHARED") };
Object.defineProperty(sneaky, "sourceClass", { get(){ return ++n === 1 ? "open_weight" : "vinci_pretrained"; } });
console.log("two-faced sourceClass  ->", m.violatesIndependence(sneaky, base("r","open_weight","SHARED")),
            "  (false = GRANTED the review; shared weights should block)");
