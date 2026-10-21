'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const SCRIPT=process.env.EVOLUTION_TEST_SCRIPT||path.join(__dirname,'evolve.js');
const ARCHIVE_ID='RC-20261009_B_REVIEW';
const TASK_ID='EVO-FIXTURE-001';

function fixture(t,opts={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cortex-b-v116-review-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const archives=path.join(root,'.agent','runtime-continuity','archives');
  const tasks=path.join(root,'.agent','tasks','evolution');
  fs.mkdirSync(archives,{recursive:true});fs.mkdirSync(tasks,{recursive:true});
  const archive=path.join(archives,`${ARCHIVE_ID}.json`);
  if(opts.archive!==false)fs.writeFileSync(archive,opts.archiveContents??JSON.stringify({
    archive_id:ARCHIVE_ID,project:'scratch',created_at:'2026-10-09T06:00:00.000Z',
    state:{done:['Completed fixture'],next:['Next action'],blockers:['Fixture blocker']}
  }));
  fs.writeFileSync(path.join(archives,'latest.json'),JSON.stringify({archive_id:ARCHIVE_ID}));
  const task=path.join(tasks,`${TASK_ID}.json`);
  if(opts.task!==false)fs.writeFileSync(task,JSON.stringify({
    task_id:TASK_ID,status:'pending',source_archive:{archive_id:ARCHIVE_ID,
      archive_path:path.relative(root,archive)},
    retry_count:opts.retryCount??0,max_retries:opts.maxRetries??3,errors:[],
    created_at:'2026-10-09T06:00:00.000Z'
  }));
  return {root,archives,tasks,archive,task};
}
function snapshot(root) {
  const rows=[];
  function visit(file,rel) {
    const stat=fs.lstatSync(file,{bigint:true});
    const v={path:rel||'.',kind:stat.isDirectory()?'dir':stat.isFile()?'file':'other',
      mode:String(stat.mode),mtimeNs:String(stat.mtimeNs)};
    if(stat.isFile()){const data=fs.readFileSync(file);
      v.sha256=crypto.createHash('sha256').update(data).digest('hex');v.size=data.length;}
    rows.push(v);
    if(stat.isDirectory())for(const child of fs.readdirSync(file).sort())
      visit(path.join(file,child),path.join(rel,child));
  }
  visit(root,'');return rows;
}
function cli(root,...args) {
  return spawnSync(process.execPath,[SCRIPT,...args],{cwd:root,encoding:'utf8',timeout:5000});
}
function direct(root,kind,value,dryRun=true) {
  // Instrument local filesystem mutators and attempted network calls around the called API.
  // Does not claim to instrument any real managed Host or distributed effect gateway.
  const runner=String.raw`
    process.chdir(process.argv[1]);
    const fs=require('node:fs'),http=require('node:http'),https=require('node:https'),net=require('node:net');
    const api=require(process.argv[2]);
    const restore=[];let fs_writes=0,network_calls=0;
    for(const method of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','copyFileSync','utimesSync','chmodSync']) {
      if(typeof fs[method]!=='function')continue;
      const old=fs[method];restore.push(()=>fs[method]=old);
      fs[method]=function(...args){fs_writes++;return old.apply(this,args);};
    }
    for(const [obj,method] of [[http,'request'],[https,'request'],[net,'connect']]) {
      const old=obj[method];restore.push(()=>obj[method]=old);
      obj[method]=function(){network_calls++;throw Error('network denied by test');};
    }
    let payload;
    try {payload={ok:true,result:process.argv[3]==='process'
      ?api.processTask(process.argv[4],{dryRun:process.argv[5]==='true'})
      :api.enqueueFromArchive(process.argv[4],{dryRun:process.argv[5]==='true'})};}
    catch(err){payload={ok:false,error:err.message};}
    finally{restore.reverse().forEach(fn=>fn());}
    process.stdout.write(JSON.stringify({...payload,fs_writes,network_calls}));
  `;
  const r=spawnSync(process.execPath,['-e',runner,root,SCRIPT,kind,value,String(dryRun)],
    {cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(r.status,0,`direct runner exit: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const json=r=>{assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
const unchanged=(before,f)=>assert.deepEqual(snapshot(f.root),before);

test('01: dry-run process success has zero writes and unchanged task',t=>{
  const f=fixture(t),before=snapshot(f.root),r=direct(f.root,'process',TASK_ID);
  assert.equal(r.ok,true);assert.equal(r.result.status,'completed');assert.equal(r.result.dry_run,true);
  assert.equal(r.fs_writes,0);assert.equal(r.network_calls,0);unchanged(before,f);
  assert.equal(JSON.parse(fs.readFileSync(f.task)).status,'pending');
});
test('02: missing archive process preview only reports in-memory failure',t=>{
  const f=fixture(t,{archive:false}),before=snapshot(f.root),r=direct(f.root,'process',TASK_ID);
  assert.equal(r.result.status,'failed');assert.equal(r.fs_writes,0);unchanged(before,f);
});
test('03: malformed archive process preview writes nothing',t=>{
  const f=fixture(t,{archiveContents:'{bad'}),before=snapshot(f.root),r=direct(f.root,'process',TASK_ID);
  assert.equal(r.result.status,'failed');assert.equal(r.fs_writes,0);unchanged(before,f);
});
test('04: retry exhaustion dry-run does not create dead-letter or delete task',t=>{
  const f=fixture(t,{archive:false,retryCount:2,maxRetries:3}),before=snapshot(f.root);
  const r=direct(f.root,'process',TASK_ID);
  assert.equal(r.result.status,'dead');assert.equal(r.fs_writes,0);unchanged(before,f);
  assert.equal(fs.existsSync(f.task),true);assert.equal(fs.existsSync(path.join(f.tasks,'_dead')),false);
});
test('05: missing task process preview errors without mutation',t=>{
  const f=fixture(t,{task:false}),before=snapshot(f.root),r=direct(f.root,'process',TASK_ID);
  assert.equal(r.ok,false);assert.match(r.error,/task not found/);assert.equal(r.fs_writes,0);unchanged(before,f);
});
test('06: enqueue preview returns null task ID and writes nothing',t=>{
  const f=fixture(t,{task:false}),before=snapshot(f.root),r=direct(f.root,'enqueue',f.archive);
  assert.equal(r.result.task_id,null);assert.equal(r.result.would_enqueue,true);
  assert.equal(r.fs_writes,0);assert.equal(r.network_calls,0);unchanged(before,f);
});
test('07: duplicate previews remain read-only (not CAS proof)',t=>{
  const f=fixture(t,{task:false}),before=snapshot(f.root);
  const a=direct(f.root,'enqueue',f.archive),b=direct(f.root,'enqueue',f.archive);
  assert.deepEqual(a.result,b.result);assert.equal(a.fs_writes+b.fs_writes,0);unchanged(before,f);
});
test('08: missing archive enqueue preview does not allocate queue',t=>{
  const f=fixture(t,{archive:false,task:false}),before=snapshot(f.root),r=direct(f.root,'enqueue',f.archive);
  assert.equal(r.ok,false);assert.match(r.error,/archive not found/);assert.equal(r.fs_writes,0);unchanged(before,f);
});
test('09: malformed JSON enqueue preview writes nothing',t=>{
  const f=fixture(t,{archiveContents:'{"bad"',task:false}),before=snapshot(f.root),r=direct(f.root,'enqueue',f.archive);
  assert.equal(r.ok,false);assert.equal(r.fs_writes,0);unchanged(before,f);
});
test('10: non-object JSON enqueue preview is rejected',t=>{
  const f=fixture(t,{archiveContents:'[]',task:false}),before=snapshot(f.root),r=direct(f.root,'enqueue',f.archive);
  assert.equal(r.ok,false);assert.match(r.error,/must be a JSON object/);unchanged(before,f);
});
test('11: CLI explicit enqueue dry-run emits preview with enqueued=0',t=>{
  const f=fixture(t,{task:false}),before=snapshot(f.root);
  const j=json(cli(f.root,'--enqueue','--archive',f.archive,'--dry-run'));
  assert.equal(j.dry_run,true);assert.equal(j.enqueued,0);assert.equal(j.previews[0].task_id,null);
  unchanged(before,f);
});
test('12: CLI enqueue-from-latest preview writes nothing',t=>{
  const f=fixture(t,{task:false}),before=snapshot(f.root);
  const j=json(cli(f.root,'--enqueue-from-latest','--dry-run'));
  assert.equal(j.enqueued,0);unchanged(before,f);
});
test('13: CLI worker once dry-run reports processed=0 and would_process=1',t=>{
  const f=fixture(t),before=snapshot(f.root);
  const j=json(cli(f.root,'--worker','--once','--dry-run'));
  assert.equal(j.dry_run,true);assert.equal(j.processed,0);
  assert.equal(j.would_process,1);assert.equal(j.task.status,'completed');unchanged(before,f);
});
test('14: CLI replay dry-run rejected before state changes',t=>{
  const f=fixture(t),before=snapshot(f.root),r=cli(f.root,'--replay',TASK_ID,'--dry-run');
  assert.equal(r.status,1);assert.match(JSON.parse(r.stdout).error,/does not support/);unchanged(before,f);
});
test('15: CLI poll-loop dry-run rejected before worker starts',t=>{
  const f=fixture(t),before=snapshot(f.root),r=cli(f.root,'--worker','--loop','--dry-run');
  assert.equal(r.status,1);unchanged(before,f);
});
test('16: normal enqueue retains legacy pending task write',t=>{
  const f=fixture(t,{task:false}),r=direct(f.root,'enqueue',f.archive,false);
  assert.equal(r.ok,true);assert.equal(r.result.status,'pending');assert.ok(r.fs_writes>0);
  assert.ok(fs.existsSync(path.join(f.tasks,`${r.result.task_id}.json`)));
});
test('17: normal process retains legacy completion and memory index',t=>{
  const f=fixture(t),r=direct(f.root,'process',TASK_ID,false);
  assert.equal(r.ok,true);assert.equal(r.result.status,'completed');assert.ok(r.fs_writes>0);
  assert.equal(JSON.parse(fs.readFileSync(f.task)).status,'completed');
  assert.ok(fs.existsSync(path.join(f.root,'.agent','memory','MEMORY.md')));
});
test('18: legacy duplicate manual enqueue behavior unchanged (dedupe NOT implemented)',t=>{
  const f=fixture(t,{task:false});
  const a=direct(f.root,'enqueue',f.archive,false),b=direct(f.root,'enqueue',f.archive,false);
  assert.equal(a.ok,true);assert.equal(b.ok,true);assert.notEqual(a.result.task_id,b.result.task_id);
});
test('19: CLI missing archive dry-run fails with no filesystem mutation',t=>{
  const f=fixture(t,{archive:false,task:false}),before=snapshot(f.root);
  const r=cli(f.root,'--enqueue','--archive',f.archive,'--dry-run');
  assert.equal(r.status,1);assert.match(JSON.parse(r.stdout).error,/archive not found/);unchanged(before,f);
});
test('20: CLI missing latest cursor dry-run fails safely',t=>{
  const f=fixture(t,{task:false});
  fs.unlinkSync(path.join(f.archives,'latest.json'));
  const before=snapshot(f.root),r=cli(f.root,'--enqueue-from-latest','--dry-run');
  assert.equal(r.status,1);assert.match(JSON.parse(r.stdout).error,/latest archive not found/);
  unchanged(before,f);
});
test('21: CLI missing source worker once dry-run returns in-memory failure',t=>{
  const f=fixture(t,{archive:false}),before=snapshot(f.root);
  const j=json(cli(f.root,'--worker','--once','--dry-run'));
  assert.equal(j.task.status,'failed');assert.equal(j.task.dry_run,true);unchanged(before,f);
});
test('22: CLI malformed source worker once dry-run returns in-memory failure',t=>{
  const f=fixture(t,{archiveContents:'{"bad":'}),before=snapshot(f.root);
  const j=json(cli(f.root,'--worker','--once','--dry-run'));
  assert.equal(j.task.status,'failed');assert.equal(j.task.dry_run,true);unchanged(before,f);
});
test('23: CLI retry-limit dry-run does not create dead task file',t=>{
  const f=fixture(t,{archive:false,retryCount:2,maxRetries:3}),before=snapshot(f.root);
  const j=json(cli(f.root,'--worker','--once','--dry-run'));
  assert.equal(j.task.status,'dead');assert.equal(fs.existsSync(f.task),true);
  assert.equal(fs.existsSync(path.join(f.tasks,'_dead')),false);unchanged(before,f);
});
test('24: CLI empty pending queue dry-run does not mutate',t=>{
  const f=fixture(t,{task:false}),before=snapshot(f.root);
  const j=json(cli(f.root,'--worker','--once','--dry-run'));
  assert.equal(j.processed,0);unchanged(before,f);
});
test('25: null archive preview rejected without file changes',t=>{
  const f=fixture(t,{archiveContents:'null',task:false}),before=snapshot(f.root);
  const r=direct(f.root,'enqueue',f.archive);
  assert.equal(r.ok,false);assert.match(r.error,/must be a JSON object/);
  assert.equal(r.fs_writes,0);unchanged(before,f);
});
test('26: multi-archive latest preview assigns zero EVO IDs',t=>{
  const f=fixture(t,{task:false});
  fs.writeFileSync(path.join(f.archives,'RC-20261009_ZZZ.json'),
    JSON.stringify({archive_id:'RC-20261009_ZZZ',created_at:'2026-10-09T07:00:00.000Z',state:{}}));
  const before=snapshot(f.root);
  const j=json(cli(f.root,'--enqueue-from-latest','--max','2','--dry-run'));
  assert.equal(j.enqueued,0);assert.equal(j.previews.length,2);
  assert.ok(j.previews.every(p=>p.dry_run&&p.task_id===null));unchanged(before,f);
});
test('27: normal worker once still reports processed=1 and persists task',t=>{
  const f=fixture(t),j=json(cli(f.root,'--worker','--once'));
  assert.equal(j.processed,1);assert.equal(j.dry_run,undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.task)).status,'completed');
});
