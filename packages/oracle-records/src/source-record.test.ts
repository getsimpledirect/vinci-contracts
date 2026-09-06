import { describe, expect, it } from "vitest";
import {
  SOURCE_COMPLETENESS,
  deliveredHandle,
  resolveCitations,
  sourceRecordDigest,
  validateDeliveredSourceHandle,
  validateSourceRecord,
} from "./index.ts";
import {
  validFailedReadSource,
  validProviderReportedSource,
  validSourceCitation,
  validSourceRecord,
} from "./fixtures.test-helpers.ts";

const issuesOf = (input: unknown): { path: string; code: string }[] => {
  const result = validateSourceRecord(input);
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
};

describe("SRC-01: a full requested range is not a full document", () => {
  it("admits a complete read of a line range that is not the whole document", () => {
    expect(issuesOf(validSourceRecord())).toEqual([]);
  });

  it("refuses a full-document claim over a range that was not the document", () => {
    expect(issuesOf({ ...validSourceRecord(), coversEntireDocument: true })).toEqual([
      { path: "/coversEntireDocument", code: "full_document_claimed_for_partial_range" },
    ]);
  });

  it("admits the same claim when the request WAS the entire document", () => {
    // The positive reachability control. Without it the rule above could be
    // "coversEntireDocument may never be true", which is a different rule.
    const whole = {
      ...validSourceRecord(),
      requestedRange: { kind: "entire_document" },
      coversEntireDocument: true,
    };
    expect(issuesOf(whole)).toEqual([]);
  });

  it("refuses a partial read that claims the full requested range", () => {
    expect(
      issuesOf({ ...validProviderReportedSource(), completeness: "FULL_REQUESTED_RANGE" }),
    ).toEqual([{ path: "/completeness", code: "partial_read_claims_full_range" }]);
  });

  it("requires the requested range to be defined, whatever the completeness says", () => {
    const undefinedRange = { ...validSourceRecord() };
    delete (undefinedRange as Record<string, unknown>).requestedRange;
    expect(issuesOf(undefinedRange)).toEqual([
      { path: "/requestedRange", code: "invalid_type" },
    ]);
  });

  it("refuses a range whose end precedes its start", () => {
    expect(
      issuesOf({
        ...validSourceRecord(),
        requestedRange: { kind: "line_range", startLine: 172, endLine: 1 },
      }),
    ).toEqual([{ path: "/requestedRange/endLine", code: "inverted_range" }]);
  });
});

describe("SRC-02: a provider report is not an independent retrieval", () => {
  it("admits a provider report that claims only what the provider did", () => {
    expect(issuesOf(validProviderReportedSource())).toEqual([]);
  });

  for (const field of ["adapterVersion", "observedBytesDigest"] as const) {
    it(`refuses ${field} on a provider report, with its own code`, () => {
      const source = validProviderReportedSource();
      const claiming = {
        ...source,
        observation: { ...source.observation, [field]: field === "adapterVersion" ? "git-read/1.2.0" : "d".repeat(64) },
      };
      expect(issuesOf(claiming)).toEqual([
        { path: `/observation/${field}`, code: "provider_reported_claims_independent_retrieval" },
      ]);
      // THE POSITIVE CONTROL, on the same field name: the independent arm
      // carries it and validates. So the refusal is about the mode, not the
      // name — and it is not the generic unknown-field rule either, which is
      // what the dedicated code above establishes.
      expect(issuesOf(validSourceRecord())).toEqual([]);
    });
  }

  it("requires a provider report to carry its provider-only attribution limitation", () => {
    expect(issuesOf({ ...validProviderReportedSource(), limitations: ["truncated"] })).toEqual([
      { path: "/limitations", code: "provider_report_without_attribution_limit" },
    ]);
  });

  it("does not impose that limitation on an independent retrieval", () => {
    // The scoping control: the rule above must not simply require the
    // limitation everywhere, which would make it say nothing about providers.
    expect(issuesOf(validSourceRecord())).toEqual([]);
    expect(validSourceRecord().limitations).toEqual([]);
  });
});

describe("SRC-04: a failed read is a typed result, never an empty success", () => {
  it("admits an unsupported-format read that obtained nothing", () => {
    expect(issuesOf(validFailedReadSource())).toEqual([]);
  });

  it("refuses a failed read that carries content", () => {
    expect(
      issuesOf({ ...validFailedReadSource(), content: validSourceRecord().content }),
    ).toEqual([{ path: "/content", code: "failed_read_with_content" }]);
  });

  it("refuses a successful read that carries none", () => {
    // The other direction, which is the shape the rule actually exists for: an
    // empty text presented as a complete read.
    expect(issuesOf({ ...validSourceRecord(), content: null })).toEqual([
      { path: "/content", code: "obtained_read_without_content" },
    ]);
  });

  it("keeps search-no-results, search-failed and complete-read-with-no-match distinct", () => {
    const base = validFailedReadSource();
    const noResults = {
      ...base,
      readOutcome: "SEARCH_NO_RESULTS",
      requestedRange: { kind: "search_query", query: "trust label" },
    };
    const searchFailed = { ...noResults, readOutcome: "SEARCH_FAILED" };
    const readNoMatch = {
      ...validSourceRecord(),
      requestedRange: { kind: "search_query", query: "trust label" },
      matchState: "NO_MATCH",
    };
    // All three are VALID records. That is the point: SRC-04 is not about
    // refusing failures, it is about being able to say which one happened.
    expect(issuesOf(noResults)).toEqual([]);
    expect(issuesOf(searchFailed)).toEqual([]);
    expect(issuesOf(readNoMatch)).toEqual([]);
    // And they are three different records, not three spellings of one.
    const digests = [noResults, searchFailed, readNoMatch].map((s) =>
      sourceRecordDigest(s as ReturnType<typeof validSourceRecord>),
    );
    expect(new Set(digests).size).toBe(3);
    expect(new Set([noResults.readOutcome, searchFailed.readOutcome, readNoMatch.readOutcome]).size).toBe(3);
  });

  it("refuses a match state on a read that obtained nothing to match", () => {
    expect(issuesOf({ ...validFailedReadSource(), matchState: "NO_MATCH" })).toEqual([
      { path: "/matchState", code: "match_state_without_content" },
    ]);
  });

  it("refuses a completeness claim on a read that obtained nothing", () => {
    expect(issuesOf({ ...validFailedReadSource(), completeness: "SNIPPET_ONLY" })).toEqual([
      { path: "/completeness", code: "unobtained_read_claims_completeness" },
    ]);
    // Control: every member of the vocabulary except NOT_OBTAINED is refused
    // here, and NOT_OBTAINED is admitted. So the rule is about the outcome and
    // not about one unlucky member.
    for (const completeness of SOURCE_COMPLETENESS) {
      const record = { ...validFailedReadSource(), completeness };
      const expected = completeness === "NOT_OBTAINED" ? [] : ["unobtained_read_claims_completeness"];
      expect(issuesOf(record).map((i) => i.code)).toEqual(expected);
    }
  });
});

describe("CON-02 on a source record: null, false, zero and not-applicable stay apart", () => {
  it("keeps four time fields separate and permits each to be unknown", () => {
    const record = validProviderReportedSource();
    expect(record.time.publishedAt).not.toBe(record.time.updatedAt);
    expect(issuesOf(record)).toEqual([]);
    // Null on each optional time field is accepted; the required one is not.
    for (const field of ["publishedAt", "updatedAt", "eventAt"] as const) {
      expect(issuesOf({ ...record, time: { ...record.time, [field]: null } })).toEqual([]);
    }
    expect(issuesOf({ ...record, time: { ...record.time, retrievedAt: null } })).toEqual([
      { path: "/time/retrievedAt", code: "invalid_timestamp" },
    ]);
  });

  it("refuses an update that precedes its own publication", () => {
    const record = validProviderReportedSource();
    expect(
      issuesOf({
        ...record,
        time: { ...record.time, updatedAt: "2018-01-01T00:00:00.000Z" },
      }),
    ).toEqual([{ path: "/time/updatedAt", code: "updated_before_published" }]);
  });

  it("distinguishes false from null on coversEntireDocument", () => {
    // false: the range was not the document. null: nothing was obtained and the
    // question has no answer. Each is legitimate in one place and refused in
    // the other, which is what makes them different values rather than two
    // spellings of "no".
    expect(issuesOf(validSourceRecord())).toEqual([]); // false, on an obtained read
    expect(issuesOf(validFailedReadSource())).toEqual([]); // null, on a failed read
    expect(issuesOf({ ...validSourceRecord(), coversEntireDocument: null })).toEqual([
      { path: "/coversEntireDocument", code: "required_field" },
    ]);
    expect(issuesOf({ ...validFailedReadSource(), coversEntireDocument: false })).toEqual([
      { path: "/coversEntireDocument", code: "document_coverage_claimed_without_content" },
    ]);
  });

  it("accepts a retrieval cost of zero and refuses a negative one", () => {
    const record = validSourceRecord();
    expect(record.observation.retrievalCostMicrousd).toBe(0);
    expect(issuesOf(record)).toEqual([]);
    expect(
      issuesOf({
        ...record,
        observation: { ...record.observation, retrievalCostMicrousd: -1 },
      }),
    ).toEqual([{ path: "/observation/retrievalCostMicrousd", code: "negative_cost" }]);
    // Null is a third value: this retrieval was not metered.
    expect(
      issuesOf({
        ...record,
        observation: { ...record.observation, retrievalCostMicrousd: null },
      }),
    ).toEqual([]);
  });
});

describe("SRC-03 / T05: only a delivered handle can become a citation", () => {
  const delivered = [validSourceRecord(), validProviderReportedSource()].map(deliveredHandle);

  it("resolves a citation of a source delivered in this run and workspace", () => {
    expect(resolveCitations([validSourceCitation()], delivered)).toEqual({
      outcome: "RESOLVED",
      sourceIds: ["oracle-source-1"],
    });
  });

  it("projects a handle that carries the identity fields and nothing else", () => {
    expect(deliveredHandle(validSourceRecord())).toEqual({
      sourceId: "oracle-source-1",
      runRef: "run-oracle-1",
      workspaceRef: "ws-institutional-1",
      presentationIndex: 1,
    });
    expect(validateDeliveredSourceHandle(deliveredHandle(validSourceRecord())).ok).toBe(true);
  });

  it("refuses an INVENTED source id", () => {
    const citation = validSourceCitation();
    const invented = {
      ...citation,
      payload: { ...citation.payload, sourceId: "oracle-source-99" },
    };
    const result = resolveCitations([invented], delivered);
    expect(result.outcome).toBe("UNRESOLVED");
    if (result.outcome !== "UNRESOLVED") return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/citations/0/payload/sourceId", code: "undelivered_source_id" },
    ]);
  });

  it("refuses a source id that exists but was never delivered to this run", () => {
    // Distinct from the invented case: this id is real and resolves elsewhere.
    // The delivered SET is what decides, not whether the id looks plausible.
    const citation = validSourceCitation();
    const undelivered = {
      ...citation,
      payload: { ...citation.payload, sourceId: "oracle-source-3" },
    };
    const result = resolveCitations([undelivered], delivered);
    expect(result.outcome).toBe("UNRESOLVED");
    if (result.outcome !== "UNRESOLVED") return;
    expect(result.issues.map((i) => i.code)).toEqual(["undelivered_source_id"]);
    // The reachability control: the same id DOES resolve once it is delivered.
    expect(
      resolveCitations([undelivered], [...delivered, deliveredHandle(validFailedReadSource())]),
    ).toEqual({ outcome: "RESOLVED", sourceIds: ["oracle-source-3"] });
  });

  it("refuses a handle delivered to another RUN", () => {
    const foreign = [{ ...deliveredHandle(validSourceRecord()), runRef: "run-somebody-else" }];
    const result = resolveCitations([validSourceCitation()], foreign);
    expect(result.outcome).toBe("UNRESOLVED");
    if (result.outcome !== "UNRESOLVED") return;
    expect(result.issues.map((i) => i.code)).toEqual(["foreign_run_source"]);
  });

  it("refuses a handle delivered to another WORKSPACE", () => {
    const foreign = [
      { ...deliveredHandle(validSourceRecord()), workspaceRef: "ws-somebody-else" },
    ];
    const result = resolveCitations([validSourceCitation()], foreign);
    expect(result.outcome).toBe("UNRESOLVED");
    if (result.outcome !== "UNRESOLVED") return;
    expect(result.issues.map((i) => i.code)).toEqual(["foreign_workspace_source"]);
  });

  it("refuses the presentation NUMBER used as a reference, by name", () => {
    // SRC-03's specific trap. "1" is a real string that names a real source in
    // one rendering and a different one in the next, so it gets its own code
    // rather than reading as an id that happens not to exist.
    const citation = validSourceCitation();
    const numbered = { ...citation, payload: { ...citation.payload, sourceId: "1" } };
    const result = resolveCitations([numbered], delivered);
    expect(result.outcome).toBe("UNRESOLVED");
    if (result.outcome !== "UNRESOLVED") return;
    expect(result.issues.map((i) => i.code)).toEqual(["presentation_index_used_as_reference"]);
  });

  it("REFUSES rather than reporting an unresolved reference when a citation is malformed", () => {
    const citation = validSourceCitation();
    const malformed = { ...citation, payload: { ...citation.payload, offeredFor: "" } };
    const result = resolveCitations([malformed], delivered);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") return;
    expect(result.issues.map((i) => i.path)).toEqual(["/citations/0/payload/offeredFor"]);
  });

  it("REFUSES a malformed delivered set rather than resolving against part of it", () => {
    // A handle that does not validate must not simply be skipped: skipping it
    // turns "we could not read the delivered set" into "that source was never
    // delivered", which is a different and much more confident claim.
    const result = resolveCitations([validSourceCitation()], [{ sourceId: "oracle-source-1" }]);
    expect(result.outcome).toBe("REFUSED");
  });

  it("refuses hostile input in either argument without throwing", () => {
    for (const hostile of [null, undefined, 7, "oracle-source-1", { kind: "toString" }]) {
      expect(resolveCitations(hostile, delivered).outcome).toBe("REFUSED");
      expect(resolveCitations([validSourceCitation()], hostile).outcome).toBe("REFUSED");
    }
    // And the control on the same call shape: legitimate input still resolves.
    expect(resolveCitations([validSourceCitation()], delivered).outcome).toBe("RESOLVED");
  });

  it("refuses an array that claims citations it does not hold", () => {
    // A DEFECT THIS FILE DID NOT CATCH, found by scripts/check-hostile-keys.mjs
    // before it shipped. `resolveCitations` used Array.isArray plus forEach,
    // and `new Array(1)` is an array whose one element forEach silently skips —
    // so a list claiming one citation resolved as a list of none. A vacuous
    // RESOLVED is exactly the answer this function exists to prevent.
    //
    // Three shapes, three ways of lying about what an array holds.
    const sneakyEvery: unknown[] = [];
    (sneakyEvery as { every: () => boolean }).every = () => true;
    (sneakyEvery as { length: number }).length = 3;
    for (const claiming of [new Array<unknown>(1), new Array<unknown>(5), sneakyEvery]) {
      expect(resolveCitations(claiming, delivered).outcome).toBe("REFUSED");
      expect(resolveCitations([validSourceCitation()], claiming).outcome).toBe("REFUSED");
    }
    // The discriminating control: a GENUINELY empty array is not a lie and
    // still resolves, so the fix did not become "refuse every short list".
    expect(resolveCitations([], delivered).outcome).toBe("RESOLVED");
    expect(resolveCitations([validSourceCitation()], delivered).outcome).toBe("RESOLVED");
  });

  it("resolves an empty citation list, which is not the same as an unresolved one", () => {
    // INV-15: a report that cites nothing is a valid report. A checker that
    // refused everything would pass every negative above.
    expect(resolveCitations([], delivered)).toEqual({ outcome: "RESOLVED", sourceIds: [] });
  });
});

describe("a repository source names the revision it was read at", () => {
  it("refuses a repository file with no revision", () => {
    const record = validSourceRecord();
    expect(
      issuesOf({ ...record, origin: { ...record.origin, repositoryRevision: null } }),
    ).toEqual([{ path: "/origin/repositoryRevision", code: "repository_source_without_revision" }]);
  });

  it("permits a web document to have none", () => {
    // The scoping control: the rule is about repository sources, and a web
    // document genuinely has no revision to name.
    expect(issuesOf(validFailedReadSource())).toEqual([]);
    expect(validFailedReadSource().origin.repositoryRevision).toBeNull();
  });

  it("refuses a 64-hex digest where a 40-hex commit id belongs", () => {
    const record = validSourceRecord();
    expect(
      issuesOf({ ...record, origin: { ...record.origin, repositoryRevision: "a".repeat(64) } }),
    ).toEqual([{ path: "/origin/repositoryRevision", code: "invalid_git_object_id" }]);
  });
});
