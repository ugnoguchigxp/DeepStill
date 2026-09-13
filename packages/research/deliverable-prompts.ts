// Keep evidence/trust rules in the shared contract; select only this turn's task.
export const navigationInstructions = `Choose ONE next action answering a missing part of originalRequest. Return {draft:null,next}. Compare candidates by the missing answer, not rank. For ambiguous terms, establish plausible meanings before deepening one. Prefer unread continuations and relevant original/specification/example links; otherwise search a focused missing answer or independent evidence. Fetch only discovered URLs; read only readableSourceIds. Search snippets are navigation, not evidence. Never retry withheld content or circumvent guards. Finish when the request is explained or meaningful authorized routes are exhausted; remaining budget is not a target. State concrete unresolved questions when unsatisfied.`;

const writing = `Explain the topic in the request language with supported mechanisms, conditions and useful examples. Distinguish source claims from independent verification and inference. Cite each paragraph and Knowledge with {sourceId,firstLine,lastLine} from supplied read lines; preserve legacy citations unchanged. References must support the whole statement, including version, API, units and exceptions. readingNotice limits what was actually read. Consolidate Knowledge into reusable explanations or decisions with applicability and boundaries; use rule and skill=null unless the evidence supports a complete executable procedure with inputs, prerequisites, steps, verification and failure handling. No scores, review cards or Episodes.`;

export const updateInstructions = `${writing}
Return {draft:null,update,next}. replaceSections and replaceKnowledge have fixed keys matching updateTargets (s0, s1; k0, k1). Return null in a slot to keep it unchanged, or {reason,value} to replace it. New items belong ONLY in appendSections/appendKnowledge. The program preserves unchanged slots. Each replacement needs a reason; retain supported mechanisms and qualifications within the replaced item unless new evidence corrects them. Do not replace unrelated items or append duplicates. Empty change lists are correct when newContent adds nothing. limitations and openQuestions are the complete updated lists: remove resolved gaps, preserve unresolved central questions. Choose one next action addressing a remaining answer, preferring relevant unread text/links; finish if answered or no meaningful authorized route remains. Do not turn a side question into a requirement absent from originalRequest. Fetch only supplied discovered URLs; never retry withheld content or circumvent guards.`;

export const deliverableInstructions = {
	deliverable_step: `${writing}
Return {draft,next}. Integrate newContent into the complete report and Knowledge, preserving supported prior content. Keep limitations/openQuestions current. Choose one relevant next action. When finalizing=true, next must be finish and use only evidence already read.`,
	deliverable_episode: `Write exactly ONE Episode for this entire research job, in the topic language, based only on supplied actual events and final deliverables. Do not generate a report, Knowledge, scores, or an Episode per search/source. Explain original intent, meaningful decisions and changes of direction, actual actions, findings and failures, outcome and remaining questions. Distinguish attempted retrieval from read evidence; no invented experience or measurements. Preserve exact executed queries where useful, but summarize repetitive failures as a group. This Episode is the history and lessons of the investigation; the report explains the topic. For saved_evidence_only, say this was a replay of an already saved document: no new search or link traversal was executed. Do not narrow the original request and then declare it satisfied. Outcome must reflect the supplied terminal reason and unresolved central questions, never claim success when stopped by a constraint.`,
};

export function stepInstructions(data: {
	navigationOnly?: boolean;
	incrementalUpdate?: boolean;
	validationError?: string;
	searchUnavailable?: unknown;
	lastSearch?: { hitCount: number } | null;
	finalizing?: boolean;
}) {
	const task = data.navigationOnly
		? navigationInstructions
		: data.incrementalUpdate
			? updateInstructions
			: deliverableInstructions.deliverable_step;
	const conditions = [
		data.searchUnavailable
			? "Search is unavailable: use relevant known sources or finish with the actual constraint."
			: "",
		data.lastSearch?.hitCount === 0
			? "Latest search had no hits: simplify the query or expand uncertain abbreviations; do not repeat it."
			: "",
		data.validationError
			? "The previous output was rejected. Correct validationError; the saved draft has not changed."
			: "",
		data.finalizing
			? "No further retrieval is allowed in this turn. Finish with the actual unresolved questions."
			: "",
	].filter(Boolean);
	return [task, ...conditions].join("\n");
}
