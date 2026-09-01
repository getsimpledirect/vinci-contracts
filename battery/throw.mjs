const m = await import("/private/tmp/claude-501/-Users-georgepu-projects/abba1454-a4c1-4597-8fa7-b65a01049117/scratchpad/wt35/packages/model-classes/dist/index.js");
const ok = (id,cls,wd)=>({schemaVersion:1,endpointId:id,capabilityProfile:{capabilities:["text"],contextLimit:1000,toolSupport:false},
  declaredCapabilities:[],credentials:{source:{kind:"managed-credential",credentialId:"c"}},
  inferenceIsExternal:{kind:"known",value:false},approvedForProtectedData:{kind:"known",value:false},
  rights:{trainingAllowed:{kind:"known",value:false},evaluationAllowed:{kind:"known",value:false},
    redistributionAllowed:{kind:"known",value:false},outputRetainedByProvider:{kind:"known",value:false},
    policySnapshotDigest:{kind:"known",value:"d"}},validFrom:"2020-01-01T00:00:00.000Z",expiresAt:null,
  sourceClass:cls,weightsDigest:wd,tokenizerDigest:"t",architectureDigest:"a",
  servingImageDigest:{kind:"known",value:"i"},quantizationDigest:{kind:"unknown"}});
const D="sha256-"+"a".repeat(64);
const attacks = [
  ["unknown sourceClass string", {...ok("a","quantum_weights",D)}],
  ["sourceClass via getter flipping to unknown", (()=>{let n=0;const o={...ok("a","open_weight",D)};
      Object.defineProperty(o,"sourceClass",{enumerable:true,get(){return ++n===1?"open_weight":"bogus";}});return o;})()],
  ["sourceClass = null", {...ok("a","open_weight",D), sourceClass:null}],
];
for (const [name,ep] of attacks) {
  try { const r = m.violatesIndependence(ep, ok("b","open_weight",D));
        console.log(`${name} -> ${r} ${r===true?"(refused, correct)":"(GRANTED)"}`); }
  catch(e){ console.log(`${name} -> THREW: ${e.message.slice(0,50)}  <-- guard must refuse, not throw`); }
}
