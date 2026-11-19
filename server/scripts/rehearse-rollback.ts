/** 只允许本机隔离部署的代码镜像回退演练；不逆迁移、不删卷、不操作云。 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createDevUser,deleteUser } from '../src/dev-user.ts';
import { hashToken } from '../src/auth-token.ts';
import { sql } from '../src/db/client.ts';
import { config } from '../src/config.ts';
const base=process.env.BASE_URL??'https://localhost:8843';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname)||new URL(config.DATABASE_URL).port!=='15432')throw new Error('只允许本机隔离数据库/HTTPS端点');
const envFile=process.env.COMPOSE_ENV_FILE;if(!envFile)throw new Error('COMPOSE_ENV_FILE required');
const composeEnv={...process.env};for(const key of ['DATABASE_URL','MODEL_PROVIDER','APP_ENV','CATTT_IMAGE','AGENT_ENABLED','MAOMAO_DEEPSEEK_API_KEY','APNS_TOPIC'])delete composeEnv[key];
const files=['--env-file',envFile,'-f','deploy/compose.staging.yml','-f','deploy/compose.local.yml'];
const a=await createDevUser('phase5-rollback-probe');const token=randomUUID();const headers={authorization:'Bearer '+token,'content-type':'application/json'};
const expect=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const request=async(path:string)=>fetch(base+path,{headers}).then(r=>{expect(r.ok,'HTTP '+r.status);return r.json() as Promise<any>;});
let restored=false;
try{
 await sql`insert into sessions(user_id,token_hash,expires_at) values(${a.userId},${hashToken(token)},now()+interval '1 hour')`;
 const before=await request('/healthz');expect(before.release==='phase5','当前代码标识');
 const body={client_id:randomUUID(),kind:'text',text:'本机回退验收记录',recorded_at:'2026-11-10T04:00:00Z',time_zone:'Asia/Shanghai',day:'2026-11-10',time:'12:00',cat_allowed:false,revision:0,mutation_id:randomUUID()};
 expect((await fetch(base+'/v1/diary',{method:'PUT',headers,body:JSON.stringify(body)})).ok,'保存canary');
 const [migration]=await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
 execFileSync('sh',['deploy/rollback.sh','cattt-phase5:rollback',...files],{stdio:'pipe',env:composeEnv});
 const old=await request('/healthz');expect(old.release===undefined&&old.ok,'旧代码没有真正启动');
 expect((await request('/v1/me')).account_id===a.userId,'回退会话/归属');expect((await request('/v1/diary')).entries.some((e:any)=>e.client_id===body.client_id),'回退数据丢失');
 execFileSync('docker',['compose',...files,'up','-d','--no-deps','--wait','api','worker'],{stdio:'pipe',env:composeEnv});restored=true;
 expect((await request('/healthz')).release==='phase5','恢复当前代码');
 const [after]=await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;expect(after!.n===migration!.n,'不应逆迁移');
 expect((await request('/v1/diary')).entries.some((e:any)=>e.client_id===body.client_id),'恢复数据丢失');
 console.log('✓ 本机代码镜像回退→旧API/worker健康→正式会话/日记保留→恢复当前代码；迁移数保持'+after!.n+'，无逆迁移');
}finally{
 try{if(!restored)execFileSync('docker',['compose',...files,'up','-d','--no-deps','--wait','api','worker'],{stdio:'pipe',env:composeEnv});
 }finally{await deleteUser(a.userId);await sql.end();}
}
