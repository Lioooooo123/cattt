/** 本机临时JWKS注入应用工厂，真实HTTP验证完整原生凭证交换与会话链路。发布配置没有此开关。 */
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { db,sql } from '../src/db/client.ts';
import { users,authNonces,asyncJobs } from '../src/db/schema.ts';
import { eq,inArray } from 'drizzle-orm';
import { closeQueues } from '../src/queue.ts';
const key=await generateKeyPair('RS256');const publicKey=await exportJWK(key.publicKey);publicKey.kid='ephemeral-smoke';publicKey.alg='RS256';
const application=createApp({audience:'local.identity.smoke',jwks:createLocalJWKSet({keys:[publicKey]})});
const server=serve({fetch:application.fetch,hostname:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('no port');const base='http://127.0.0.1:'+address.port;
const ids:string[]=[];const hashes:string[]=[];const subject=randomUUID();
const expect=(v:unknown,m:string)=>{if(!v)throw new Error(m);};
const post=async(path:string,body:unknown,token?:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
async function login(){const r=await post('/auth/nonce',{});const{nonce}=await r.json() as any;hashes.push(hashToken(nonce));const jwt=await new SignJWT({nonce:hashToken(nonce)}).setProtectedHeader({alg:'RS256',kid:'ephemeral-smoke'}).setIssuer('https://appleid.apple.com').setAudience('local.identity.smoke').setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(key.privateKey);const result=await post('/auth/apple',{identity_token:jwt,nonce});expect(result.status===200,'native identity exchange');const a=await result.json() as any;ids.push(a.account_id);return a;}
try{
 const a=await login(),b=await login();expect(a.account_id===b.account_id&&a.cat.id===b.cat.id,'duplicate account');const headers={authorization:'Bearer '+b.token,'content-type':'application/json'};
 const me=await fetch(base+'/v1/me',{headers}).then(r=>r.json()) as any;expect(me.account_id===b.account_id,'account identity');
 const note={client_id:randomUUID(),kind:'text',text:'正式会话HTTP验收小记',recorded_at:'2026-11-10T04:00:00Z',time_zone:'Asia/Shanghai',day:'2026-11-10',time:'12:00',cat_allowed:false,revision:0,mutation_id:randomUUID()};
 expect((await fetch(base+'/v1/diary',{method:'PUT',headers,body:JSON.stringify(note)})).status===200,'diary write');
 const page=await fetch(base+'/v1/diary',{headers}).then(r=>r.json()) as any;expect(page.entries.length===1,'stable account diary');
 const response=await post('/v1/messages',{client_message_id:randomUUID(),text:'你好'},b.token);expect(response.status===200,'chat accepted');const stream=await response.text();expect(stream.includes('event: done'),'chat complete');
 await post('/v1/session/logout',{},b.token);expect((await fetch(base+'/v1/me',{headers})).status===401,'logout revoked');
 console.log('✓ 正式身份真实HTTP：临时JWT/JWKS→原生凭证交换→重复登录同猫→账号/日记/聊天→退出撤销');
}finally{
 server.close();
 for(const id of new Set(ids)){await sql`delete from async_jobs where source_id in(select id from triggers where cat_id in(select id from cats where user_id=${id})) or source_id in(select m.id from messages m join conversations v on v.id=m.conversation_id join cats c on c.id=v.cat_id where c.user_id=${id})`;await db.delete(users).where(eq(users.id,id));}
 if(hashes.length)await db.delete(authNonces).where(inArray(authNonces.hash,hashes));await closeQueues();await sql.end();
}
