const m = await import("/private/tmp/claude-501/-Users-georgepu-projects/abba1454-a4c1-4597-8fa7-b65a01049117/scratchpad/wt35/packages/model-classes/dist/index.js");
const D="sha256-"+"a".repeat(64);
const base=(id)=>({schemaVersion:1,endpointId:id,capabilityProfile:{capabilities:["text"],contextLimit:1000,toolSupport:false},
  declaredCapabilities:[],credentials:{source:{kind:"managed-credential",credentialId:"c"}},
  inferenceIsExternal:{kind:"known",value:false},approvedForProtectedData:{kind:"known",value:false},
  rights:{trainingAllowed:{kind:"known",value:false},evaluationAllowed:{kind:"known",value:false},
    redistributionAllowed:{kind:"known",value:false},outputRetainedByProvider:{kind:"known",value:false},
    policySnapshotDigest:{kind:"known",value:"d"}},validFrom:"2020-01-01T00:00:00.000Z",expiresAt:null,
  tokenizerDigest:"t",architectureDigest:"a",servingImageDigest:{kind:"known",value:"i"},quantizationDigest:{kind:"unknown"}});
// servedArtifact flips: proprietary (grants) on read 1, matching digest (blocks) on read 2
let n=0;
const f={...base("f"),sourceClass:"frontier_api",provider:"openai",model:"m"};
Object.defineProperty(f,"servedArtifact",{enumerable:true,get(){n++;
  return n===1?{kind:"known",value:{kind:"digest",value:D}}:{kind:"known",value:{kind:"proprietary"}};}});
const pod={...base("p"),sourceClass:"open_weight",weightsDigest:D};
const v = m.violatesIndependence(f,pod);
console.log(`two-faced servedArtifact -> ${v}  reads=${n}   ${v===true&&n===1?"PASS (blocked, read once)":"FAIL"}`);
// inner .value as a getter too
let k=0; const inner={kind:"known"};
Object.defineProperty(inner,"value",{enumerable:true,get(){k++;return k===1?{kind:"digest",value:D}:{kind:"proprietary"};}});
const f2={...base("f2"),sourceClass:"frontier_api",provider:"openai",model:"m",servedArtifact:inner};
const v2 = m.violatesIndependence(f2,pod);
console.log(`two-faced inner .value   -> ${v2}  reads=${k}   ${v2===true&&k<=1?"PASS":"FAIL"}`);
