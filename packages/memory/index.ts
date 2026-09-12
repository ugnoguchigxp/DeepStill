import { createHash } from "node:crypto";
import type { Artifact, Candidate, JobDetail } from "../contracts";
import type { MemoryBundle } from "./schema";
export * from "./schema";
const eventTypes = new Set(["job.started", "round.started", "round.evaluated", "round.opportunities_reviewed", "source.skipped", "source.retry", "query.scope_checked", "artifact.revised", "budget.adjusted"]);
export function memoryInput(detail: JobDetail) {
 const claims = detail.claims.filter(c => c.accepted);
 const evidence = claims.flatMap(c => c.evidenceIds.map(id => {
  const e = detail.evidence.find(e => e.id === id);
  const s = detail.sources.find(s => s.id === e?.snapshotId);
  if (!e || !s || s.text.slice(e.start,e.end) !== e.quote) throw new Error("MEMORY_EVIDENCE_INVALID");
  return {claimId:c.id,evidenceId:e.id,snapshotId:s.id,hash:s.hash,url:s.finalUrl,start:e.start,end:e.end,unit:"utf16" as const,quote:e.quote};
 }));
 const events = detail.events.filter(e => eventTypes.has(e.type));
 const input = {topic:detail.job.topic, revision:detail.research?.revision ?? 0,
  claims:claims.map(c=>({id:c.id,text:c.text,kind:c.kind,relatedClaimIds:c.relatedClaimIds})),evidence,events};
 return {...input,inputHash:createHash("sha256").update(JSON.stringify(input)).digest("hex")};
}
export function emptyBundle(detail:JobDetail, previous?: MemoryBundle):MemoryBundle {
 const input=memoryInput(detail);
 return {id:`memory:${input.inputHash}`,schemaVersion:"memory-v1",inputHash:input.inputHash,revision:input.revision,jobId:detail.job.id,topic:detail.job.topic,asOf:new Date().toISOString(),supersedes:previous?.id ?? null,
 knowledge:[],episodes:[],concepts:[],relations:[],evidence:input.evidence,review:null,status:"draft",structuralIssues:[]};
}
export function validateMemory(bundle:MemoryBundle, detail:JobDetail):string[] {
 const issues:string[]=[];
 const claims=new Set(detail.claims.filter(c=>c.accepted).map(c=>c.id));
 const events=new Set(memoryInput(detail).events.map(e=>e.id));
 const objects=[...bundle.knowledge,...bundle.episodes,...bundle.concepts];
 const ids=new Set(objects.map(o=>o.id));
 if(ids.size!==objects.length) issues.push("duplicate_memory_id");
 for(const o of objects) for(const id of o.claimIds) if(!claims.has(id)) issues.push(`${o.id}:unknown_claim:${id}`);
 for(const k of bundle.knowledge) {
  if(!k.id.startsWith("k:")) issues.push(`${k.id}:id_prefix`);
  if(!k.appliesWhen.length) issues.push(`${k.id}:missing_conditions`);
  if(k.type==="procedure" && (k.steps.length<2||!k.verification.length||k.polarity==="negative")) issues.push(`${k.id}:incomplete_procedure`);
 }
 for(const e of bundle.episodes) {
  if(!e.id.startsWith("ep:")) issues.push(`${e.id}:id_prefix`);
  for(const id of e.eventIds) if(!events.has(id)) issues.push(`${e.id}:unknown_event:${id}`);
 }
 for(const c of bundle.concepts) if(!c.id.startsWith("c:")) issues.push(`${c.id}:id_prefix`);
 for(const r of bundle.relations) {
  if(!ids.has(r.from)||!ids.has(r.to)) issues.push("dangling_relation");
  for(const id of r.claimIds) if(!claims.has(id)) issues.push(`relation:unknown_claim:${id}`);
 }
 const requirements=new Set(["general",...(detail.memoryBrief?.requirements.map(r=>r.id)??[])]);
 for(const d of bundle.review?.defects??[]) {
  if(d.targetId!=="bundle"&&!ids.has(d.targetId)) issues.push("unknown_defect_target");
  if(!requirements.has(d.requirementId)) issues.push("unknown_requirement");
  for(const id of d.claimIds) if(!claims.has(id)) issues.push("unknown_defect_claim");
 }
 for(const e of bundle.evidence) {
  const s=detail.sources.find(s=>s.id===e.snapshotId);
  const original=detail.evidence.find(x=>x.id===e.evidenceId);
  if(!s||s.hash!==e.hash||s.text.slice(e.start,e.end)!==e.quote||!original||original.snapshotId!==e.snapshotId||original.start!==e.start||original.end!==e.end||!detail.claims.find(c=>c.id===e.claimId)?.evidenceIds.includes(e.evidenceId)) issues.push("invalid_locator");
 }
 return [...new Set(issues)];
}
/** An LLM review estimate is not a holdout reuse-test result. */
export function memoryReviewPass(bundle:MemoryBundle) {
 return bundle.status==="reviewed" && bundle.structuralIssues.length===0 && !!bundle.review && Object.values(bundle.review.scores).every(n=>n>90) && !bundle.review.defects.some(d=>d.critical||d.route!=="supplement");
}
export function memoryCandidates(bundle:MemoryBundle, artifact:Artifact):Candidate[] {
 return [
 ...bundle.knowledge.map(k=>({id:`${bundle.id}:${k.id}`,type:"knowledge" as const,text:JSON.stringify(k,null,2),claimIds:k.claimIds})),
 ...bundle.episodes.map(e=>({id:`${bundle.id}:${e.id}`,type:"episode" as const,text:JSON.stringify(e,null,2),claimIds:e.claimIds,eventIds:e.eventIds})),
 ].map(c=>({...c,memoryId:bundle.id,artifactVersion:artifact.version,adoption:"pending" as const}));
}
export function searchMemory(bundle:MemoryBundle,query:string,limit=10) {
 const q=query.normalize("NFKC").toLowerCase();
 return [...bundle.knowledge.map(x=>({id:x.id,title:x.title,text:x.body})),...bundle.episodes.map(x=>({id:x.id,title:x.title,text:[x.context,...x.triggers].join(" ")})),...bundle.concepts.map(x=>({id:x.id,title:x.name,text:[x.description,...x.aliases].join(" ")}))]
 .filter(x=>`${x.title} ${x.text}`.normalize("NFKC").toLowerCase().includes(q)).slice(0,Math.max(1,Math.min(50,limit)));
}
export function memoryObject(bundle:MemoryBundle,id:string) {
 return [...bundle.knowledge,...bundle.episodes,...bundle.concepts].find(x=>x.id===id)??null;
}
export function drillMemory(bundle:MemoryBundle,detail:JobDetail,evidenceId:string) {
 const refs=bundle.evidence.filter(e=>e.evidenceId===evidenceId);
 if(!refs.length) return null;
 const e=refs[0], s=detail.sources.find(s=>s.id===e.snapshotId);
 if(!s||s.hash!==e.hash||s.text.slice(e.start,e.end)!==e.quote) throw new Error("MEMORY_LOCATOR_STALE");
 return {...e,claimIds:refs.map(e=>e.claimId),context:s.text.slice(Math.max(0,e.start-450),e.end+450)};
}
export function contextStillExport(bundle:MemoryBundle) {
 return {schemaVersion:"contextstill-dry-run-v1",sourceMemoryId:bundle.id,writePerformed:false,
  knowledge:bundle.knowledge.map(k=>({type:k.type,polarity:k.polarity,title:k.title,status:"draft",body:k.type==="procedure"?`Use when:\n${k.appliesWhen.join("\n")}\nWorkflow:\n${k.steps.map((s,i)=>`${i+1}. ${s}`).join("\n")}\nVerification:\n${k.verification.join("\n")}\nAvoid:\n${k.notApplicableWhen.join("\n")||"未確認"}`:k.body,metadata:{memoryId:bundle.id,canonical:k,refs:bundle.evidence.filter(e=>k.claimIds.includes(e.claimId))}})),
  episodes:bundle.episodes.map(e=>({canonical:e,asOf:bundle.asOf,requiresAdapterContract:true})),
  unresolvedContracts:["Episode sourceKind and event/raw-file reference mapping requires target contract validation"],
 };
}
