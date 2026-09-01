const m = await import("/private/tmp/claude-501/-Users-georgepu-projects/abba1454-a4c1-4597-8fa7-b65a01049117/scratchpad/wt35/packages/model-classes/dist/index.js");
const ep=(id,cls,wd)=>({schemaVersion:1,endpointId:id,
  capabilityProfile:{capabilities:["text"],contextLimit:1000,toolSupport:false},declaredCapabilities:[],
  credentials:{source:{kind:"managed-credential",credentialId:"c"}},
  inferenceIsExternal:{kind:"known",value:false},approvedForProtectedData:{kind:"known",value:false},
  rights:{trainingAllowed:{kind:"known",value:false},evaluationAllowed:{kind:"known",value:false},
    redistributionAllowed:{kind:"known",value:false},outputRetainedByProvider:{kind:"known",value:false},
    policySnapshotDigest:{kind:"known",value:"d"}},
  validFrom:"2020-01-01T00:00:00.000Z",expiresAt:null,sourceClass:cls,weightsDigest:wd,
  tokenizerDigest:"t",architectureDigest:"a",servingImageDigest:{kind:"known",value:"i"},
  quantizationDigest:{kind:"unknown"}});
const SAME="sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
console.log("open_weight vs vinci_pretrained, SAME weights ->",
  m.violatesIndependence(ep("a","open_weight",SAME), ep("b","vinci_pretrained",SAME)),
  " (must be true = NOT independent)");
console.log("open_weight vs vinci_pretrained, DIFFERENT weights ->",
  m.violatesIndependence(ep("a","open_weight",SAME), ep("b","vinci_pretrained",SAME.replace(/a/g,"b"))),
  " (false = independent, correct)");
console.log("frontier_api vs open_weight ->",
  m.violatesIndependence({...ep("a","frontier_api",SAME),provider:"anthropic",model:"x"}, ep("b","open_weight",SAME)),
  " (false = independent, different identity schemes)");
