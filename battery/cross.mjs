const m = await import("/private/tmp/claude-501/-Users-georgepu-projects/abba1454-a4c1-4597-8fa7-b65a01049117/scratchpad/wt35/packages/model-classes/dist/index.js");
const base=(id)=>({schemaVersion:1,endpointId:id,
  capabilityProfile:{capabilities:["text"],contextLimit:1000,toolSupport:false},declaredCapabilities:[],
  credentials:{source:{kind:"managed-credential",credentialId:"c"}},
  inferenceIsExternal:{kind:"known",value:false},approvedForProtectedData:{kind:"known",value:false},
  rights:{trainingAllowed:{kind:"known",value:false},evaluationAllowed:{kind:"known",value:false},
    redistributionAllowed:{kind:"known",value:false},outputRetainedByProvider:{kind:"known",value:false},
    policySnapshotDigest:{kind:"known",value:"d"}},
  validFrom:"2020-01-01T00:00:00.000Z",expiresAt:null,tokenizerDigest:"t",architectureDigest:"a",
  servingImageDigest:{kind:"known",value:"i"},quantizationDigest:{kind:"unknown"}});
const D="sha256-"+"a".repeat(64);
// Bedrock SERVES open-weight models. Same Llama weights, two ways to reach them.
const viaBedrock = {...base("bedrock-llama"), sourceClass:"frontier_api", provider:"openai", model:"llama-3-70b"};
const onOurPod   = {...base("pod-llama"),     sourceClass:"open_weight",  weightsDigest:D};
console.log("frontier(llama via API) vs open_weight(same llama on our pod) ->",
  m.violatesIndependence(viaBedrock, onOurPod));
console.log("   false = INDEPENDENT = the model is authorised to review its own output");
