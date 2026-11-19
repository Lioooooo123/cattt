import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { eq,inArray } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users, cats, conversations, sessions, authNonces } from '../src/db/schema.ts';
import { createIdentityRoutes, revokeSession } from '../src/identity/service.ts';
import { app } from '../src/api/app.ts';
import { config } from '../src/config.ts';
import { hashToken } from '../src/auth-token.ts';
let keys:Awaited<ReturnType<typeof generateKeyPair>>, identity:Hono;
const ids:string[]=[];const nonces:string[]=[];const prefix=randomUUID();
beforeAll(async()=>{
 keys=await generateKeyPair('RS256');const jwk=await exportJWK(keys.publicKey);jwk.kid='local-test';jwk.alg='RS256';
 identity=new Hono().route('/auth',createIdentityRoutes({audience:'local.test.cat',jwks:createLocalJWKSet({keys:[jwk]})}));
});
afterAll(async()=>{for(const id of ids)await db.delete(users).where(eq(users.id,id));if(nonces.length)await db.delete(authNonces).where(inArray(authNonces.hash,nonces));await sql.end();});
const request=(path:string,body:unknown)=>identity.request('/auth/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const challenge=async()=>{const r=await request('nonce',{});expect(r.status).toBe(200);const value=(await r.json()).nonce as string;nonces.push(hashToken(value));return value;};
async function token(nonce:string,subject:string=prefix,change:Record<string,unknown>={}){return new SignJWT({nonce:hashToken(nonce),...change}).setProtectedHeader({alg:'RS256',kid:'local-test'}).setIssuer('https://appleid.apple.com').setAudience('local.test.cat').setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);}
async function login(subject:string=prefix){const nonce=await challenge();const r=await request('apple',{identity_token:await token(nonce,subject),nonce});expect(r.status).toBe(200);const value=await r.json();if(!ids.includes(value.account_id))ids.push(value.account_id);return value;}
it('真实JWT/JWKS验证，重复登录同账号只有一猫一对话，会话只存hash且旧会话不变',async()=>{
 const a=await login(),b=await login();expect(a.account_id).toBe(b.account_id);expect(a.token).not.toBe(b.token);
 expect(await db.select().from(cats).where(eq(cats.userId,a.account_id))).toHaveLength(1);expect(await db.select().from(conversations).where(eq(conversations.catId,a.cat.id))).toHaveLength(1);
 const rows=await db.select().from(sessions).where(eq(sessions.userId,a.account_id));expect(rows.some(s=>s.tokenHash===hashToken(a.token))).toBe(true);expect(JSON.stringify(rows)).not.toContain(a.token);
 expect((await app.request('/v1/diary',{headers:{authorization:'Bearer '+a.token}})).status).toBe(200);
});
it('无效签名、过期、issuer、audience、nonce错误或重放均拒绝',async()=>{
 const nonce=await challenge();const jwt=await token(nonce);
 for(const identity_token of [jwt.slice(0,-8)+'invalidx',await token(nonce,prefix,{nonce:'wrong'}),await new SignJWT({nonce:hashToken(nonce)}).setProtectedHeader({alg:'RS256',kid:'local-test'}).setIssuer('https://wrong.example').setAudience('local.test.cat').setSubject(prefix).setExpirationTime('5m').sign(keys.privateKey),await new SignJWT({nonce:hashToken(nonce)}).setProtectedHeader({alg:'RS256',kid:'local-test'}).setIssuer('https://appleid.apple.com').setAudience('wrong').setSubject(prefix).setExpirationTime('5m').sign(keys.privateKey),await new SignJWT({nonce:hashToken(nonce)}).setProtectedHeader({alg:'RS256',kid:'local-test'}).setIssuer('https://appleid.apple.com').setAudience('local.test.cat').setSubject(prefix).setExpirationTime('0s').sign(keys.privateKey)])expect((await request('apple',{nonce,identity_token})).status).toBe(401);
 const responses=await Promise.all([request('apple',{nonce,identity_token:jwt}),request('apple',{nonce,identity_token:jwt})]);expect(responses.map(r=>r.status).sort()).toEqual([200,401]);const a=await responses.find(r=>r.status===200)!.json();if(!ids.includes(a.account_id))ids.push(a.account_id);
});
it('会话过期/退出撤销，跨账号隔离；发布环境拒绝dev token',async()=>{
 const a=await login(),b=await login(prefix+'other');expect(a.account_id).not.toBe(b.account_id);
 const response=await app.request('/v1/cat',{headers:{authorization:'Bearer '+b.token}});expect((await response.json()).id).toBe(b.cat.id);
 await revokeSession(a.token);expect((await app.request('/v1/diary',{headers:{authorization:'Bearer '+a.token}})).status).toBe(401);
 await db.update(sessions).set({expiresAt:new Date(0)}).where(eq(sessions.tokenHash,hashToken(b.token)));expect((await app.request('/v1/diary',{headers:{authorization:'Bearer '+b.token}})).status).toBe(401);
 const dev=randomUUID();await db.update(users).set({devTokenHash:hashToken(dev)}).where(eq(users.id,a.account_id));const old=config.APP_ENV;
 try{config.APP_ENV='staging';expect((await app.request('/v1/cat',{headers:{authorization:'Bearer '+dev}})).status).toBe(401);}finally{config.APP_ENV=old;}
});
