"use strict";
const records = [
  ["decisions/D-release-1.15.0-eca99a7c.json","decision_id","D-release-1.15.0-eca99a7c"],
  ["waitpoints/WP-release-1.15.0-eca99a7c.json","waitpoint_id","WP-release-1.15.0-eca99a7c"]
];
class PreflightError extends Error {
  constructor(code){ super("GOVERNANCE_READ_PREFLIGHT_BLOCKED: "+code); this.code=code; }
}
async function probe(token, requester=fetch) {
  if (!token || typeof token !== "string") throw new PreflightError("SECRET_MISSING");
  for (const [file,field,expected] of records) {
    let response;
    try {
      response = await requester("https://api.github.com/repos/Kucell/cortex-agent-agent/contents/"+file+"?ref=main",{
        headers:{
          Authorization:"Bearer "+token,
          Accept:"application/vnd.github+json",
          "X-GitHub-Api-Version":"2022-11-28"
        },
        redirect:"error",
        signal:AbortSignal.timeout(10000)
      });
    } catch (_) { throw new PreflightError("PRIVATE_API_UNAVAILABLE"); }
    if (!response || !response.ok) throw new PreflightError("PRIVATE_CONTENT_READ_DENIED");
    let data;
    try {
      const payload=await response.json();
      if (payload.type!=="file" || payload.encoding!=="base64" || typeof payload.content!=="string") throw Error();
      data=JSON.parse(Buffer.from(payload.content,"base64").toString("utf8"));
    } catch (_) { throw new PreflightError("PRIVATE_CONTENT_UNREADABLE"); }
    if (!data || data[field]!==expected) throw new PreflightError("RECORD_ID_MISMATCH");
  }
  return {read_only_access_verified:true,record_count:records.length};
}
async function main() {
  if (process.env.GITHUB_REPOSITORY!=="Kucell/cortex-agent" ||
      process.env.GITHUB_REF!=="refs/heads/main") throw new PreflightError("MAIN_REQUIRED");
  if (process.env.CORTEX_AUTO_RELEASE_ENABLED!=="false") throw new PreflightError("AUTO_PUBLISH_MUST_REMAIN_DISABLED");
  const result=await probe(process.env.CORTEX_GOVERNANCE_READ_TOKEN);
  console.log("Private governance read access verified for "+result.record_count+" records; auto publish remains disabled.");
}
if(require.main===module) main().catch(e=>{
  console.error(e instanceof PreflightError?e.message:"GOVERNANCE_READ_PREFLIGHT_BLOCKED: UNKNOWN");
  process.exitCode=1;
});
module.exports={probe,PreflightError};
