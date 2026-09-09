import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const dir = await mkdtemp(join(root, 'scripts/.task-checkpoint-smoke-'))
try {
  const dbPath = join(dir, 'db.ts'), entry = join(dir, 'test.ts'), bundle = join(dir, 'test.mjs')
  await writeFile(dbPath, `
import { DatabaseSync } from 'node:sqlite'
export const db = new DatabaseSync(':memory:')
export function getTursoClient() { return {execute:tursoExecuteIsolated} }
export function getTursoSetupStatus() { return {configured:true, missing:[]} }
export async function tursoExecute(sql: string, args: any[] = []) {
 const statement = db.prepare(sql)
 if (statement.columns().length) return {rows:statement.all(...args), rowsAffected:0}
 const result = statement.run(...args)
 return {rows:[], rowsAffected:Number(result.changes)}
}
export async function tursoExecuteIsolated(statement: any) {return tursoExecute(statement.sql, statement.args)}
export async function tursoTransaction(mode: any, fn: any) {return fn({execute:tursoExecuteIsolated})}
`)
  await writeFile(entry, `
import assert from 'node:assert/strict'
import { db, tursoExecute } from ${JSON.stringify(dbPath)}
import { CheckpointTestEmitter } from ${JSON.stringify(join(root, 'src/lib/agent/taskJobs.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { captureTaskCheckpoint } from ${JSON.stringify(join(root, 'src/lib/agent/TaskCheckpoint.ts'))}
import { WorkingMemory } from ${JSON.stringify(join(root, 'src/lib/agent/WorkingMemory.ts'))}
import { sanitizeAgentEventEmitter } from ${JSON.stringify(join(root, 'src/lib/agent/SSEEmitter.ts'))}

await tursoExecute('create table agent_task_jobs (run_id text primary key, user_id text, conversation_id text, queue_name text, status text, terminal_status text, cancel_requested integer, worker_id text, attempts integer, lease_expires_at_ms integer, started_at_ms integer, updated_at_ms integer, completed_at_ms integer)')
await tursoExecute('create table agent_task_events (run_id text, seq integer, event_json text)')
await tursoExecute('insert into agent_task_jobs (run_id,user_id,conversation_id,queue_name,status,terminal_status,cancel_requested,worker_id,attempts,lease_expires_at_ms) values (?,?,?,?,?,?,?,?,?,?)',
 ['run','user','conversation','queue','running',null,0,'worker',1,Date.now()+60000])
const timeouts = {iterationTimeoutMs:30000,inactivityTimeoutMs:30000,contentOnlyTimeoutMs:null,contentOnlyMinChars:0,checkIntervalMs:20}
const state = createInitialState(false, timeouts)
state.currentPlanItems = ['Research', 'Deliver']
state.currentPlanScopes = [null,null]
state.originalUserRequest = 'Research and deliver a report'
state.dynamicIterationLimit = 30
const memory = new WorkingMemory(state.originalUserRequest)
memory.extractFromBrowse('https://example.com/research','The research project found a substantial improvement in measured performance.',0)
const checkpoint = captureTaskCheckpoint(state, memory)!
const job: any = {runId:'run',userId:'user',conversationId:'conversation',queueName:'queue',claimWorkerId:'worker',claimAttempts:1,nextSeq:2,closed:false}
const emitter = new CheckpointTestEmitter(job)
let flushed = false
emitter.flush = async () => {
 flushed = true
 await tursoExecute('insert into agent_task_events values (?,?,?)', ['run',1,JSON.stringify({type:'tool_result',id:'1',name:'read_file',result:{path:'source.md'}})])
}
await sanitizeAgentEventEmitter(emitter).saveCheckpoint!(checkpoint)
assert.ok(flushed, 'durable event flush must precede the checkpoint write')
let saved = JSON.parse(String(db.prepare('select checkpoint_json from agent_task_jobs').get()!.checkpoint_json))
assert.equal(saved.eventSeq, 1)
assert.equal(saved.currentStepIdx, 0)

// Simulate a crash after successful writes and advancement, before the next snapshot.
await tursoExecute('insert into agent_task_events values (?,?,?)', ['run',2,JSON.stringify({type:'tool_result',id:'2',name:'create_file',result:{action:'created',path:'notes.md',size:200}})])
await tursoExecute('insert into agent_task_events values (?,?,?)', ['run',3,JSON.stringify({type:'step_advance',status:'done'})])
const successorJob = {...job,claimWorkerId:'successor',claimAttempts:2,nextSeq:4}
await tursoExecute('update agent_task_jobs set worker_id = ?, attempts = ?', ['successor',2])
const successor = new CheckpointTestEmitter(successorJob)
successor.flush = async () => {}
const restored = await sanitizeAgentEventEmitter(successor).loadCheckpoint!()
assert.equal(restored!.currentStepIdx, 1)
assert.ok(restored!.sets.createdFiles.includes('notes.md'))
assert.equal(restored!.memory.facts[0].text, checkpoint.memory.facts[0].text)
assert.equal(restored!.workLog.filter(line => line.includes('Completed create_file')).length, 1)
emitter.flush = async () => {}
await assert.rejects(emitter.saveCheckpoint(checkpoint), /claim/i, 'old worker must not overwrite the successor checkpoint')
for (const key of ['userId','conversationId','queueName']) {
 const wrong = new CheckpointTestEmitter({...successorJob,[key]:'wrong'})
 wrong.flush = async () => {}
 await assert.rejects(wrong.loadCheckpoint(), /claim/i)
 await assert.rejects(wrong.saveCheckpoint(checkpoint), /claim/i)
}
await tursoExecute('update agent_task_jobs set lease_expires_at_ms = 1')
await assert.rejects(successor.saveCheckpoint(checkpoint), /claim/i, 'an expired lease cannot write task state')
await tursoExecute('update agent_task_jobs set lease_expires_at_ms = ?, cancel_requested = 1', [Date.now()+60000])
await assert.rejects(successor.saveCheckpoint(checkpoint), /claim/i, 'cancelled tasks cannot save new progress')
await tursoExecute('update agent_task_jobs set cancel_requested = 0, checkpoint_json = ?', ['{broken'])
await assert.rejects(successor.loadCheckpoint(), /could not be validated/)
await tursoExecute('update agent_task_jobs set checkpoint_json = null')
assert.equal(await successor.loadCheckpoint(), null, 'older jobs without checkpoints still use existing journal recovery')
let attemptedSave = false
successor.flush = async () => { throw new Error('event persistence failed') }
try { await successor.saveCheckpoint(checkpoint); attemptedSave = true } catch {}
assert.equal(attemptedSave, false)
assert.equal(db.prepare('select checkpoint_json from agent_task_jobs').get()!.checkpoint_json, null, 'failed event persistence must not leave a checkpoint claiming success')
db.close()
console.log('durable checkpoint ownership, crash reconciliation, and failure fences passed')
`)
  await build({entryPoints:[entry], outfile:bundle, bundle:true, platform:'node', format:'esm', target:['node22'], logLevel:'silent',
    external:['fsevents','playwright-core','chromium-bidi/*'],
    plugins:[{name:'checkpoint-database-test',setup(build) {
      build.onResolve({filter:/^(?:@\/lib\/db\/turso|\.\/db\/turso)$/}, () => ({path:dbPath}))
      build.onLoad({filter:/\/agent\/taskJobs\.ts$/}, async args => ({contents:(await readFile(args.path,'utf8'))+'\nexport { TaskJobEmitter as CheckpointTestEmitter }\n',loader:'ts'}))
    }}]})
  await import(pathToFileURL(bundle).href)
} finally { await rm(dir, {recursive:true, force:true}) }
console.log('task checkpoint smoke passed')
