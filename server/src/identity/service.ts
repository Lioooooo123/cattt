import { randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { authNonces, users, cats, conversations, sessions } from '../db/schema.ts';
import { hashToken } from '../auth-token.ts';
import { config } from '../config.ts';
import { DEFAULT_TRAITS } from '../runtime/persona.ts';
const appleKeys=createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'),{timeoutDuration:5000});
export const accountJSON=(c:typeof cats.$inferSelect)=>({id:c.id,name:c.name,appearance:c.appearance,temperament:c.temperament,traits:c.traits,created_at:c.createdAt});
export async function revokeSession(token:string){await db.update(sessions).set({revokedAt:sql`now()`}).where(eq(sessions.tokenHash,hashToken(token)));}
/** JWKS注入仅由测试构造路由调用；运行配置没有替代JWKS或跳过校验开关。 */
export function createIdentityRoutes(options:{audience?:string;jwks?:JWTVerifyGetKey}={}){
 const routes=new Hono();
 routes.post('/nonce',async c=>{
  if(!(options.audience??config.APPLE_CLIENT_ID))return c.json({error:{code:'identity_unconfigured'}},503);
  const nonce=randomBytes(32).toString('base64url');await db.insert(authNonces).values({hash:hashToken(nonce),expiresAt:sql`now()+interval '10 minutes'`});
  return c.json({nonce});
 });
 routes.post('/apple',async c=>{
  const audience=options.audience??config.APPLE_CLIENT_ID;if(!audience)return c.json({error:{code:'identity_unconfigured'}},503);
  const parsed=z.object({identity_token:z.string().max(12000),nonce:z.string().min(32).max(100)}).strict().safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:{code:'bad_request'}},400);
  const {identity_token,nonce}=parsed.data;
  let sub:string;
  try{
   const {payload}=await jwtVerify(identity_token,options.jwks??appleKeys,{issuer:'https://appleid.apple.com',audience,algorithms:['RS256','ES256'],requiredClaims:['sub','iat','exp','nonce'],maxTokenAge:'10m'});
   if(payload.nonce!==hashToken(nonce)||!payload.sub)throw new Error('nonce');sub=payload.sub;
  }catch{return c.json({error:{code:'apple_identity_invalid',message:'登录凭证已失效，请重试'}},401);}
  const result=await db.transaction(async tx=>{
   const [used]=await tx.update(authNonces).set({usedAt:sql`now()`}).where(and(eq(authNonces.hash,hashToken(nonce)),isNull(authNonces.usedAt),gt(authNonces.expiresAt,sql`now()`))).returning();
   if(!used)return null;
   const [user]=await tx.insert(users).values({appleSub:sub}).onConflictDoUpdate({target:users.appleSub,set:{appleSub:sub}}).returning();
   let [cat]=await tx.select().from(cats).where(eq(cats.userId,user!.id));
   if(!cat){[cat]=await tx.insert(cats).values({userId:user!.id,name:'团子',appearance:'orange',temperament:'slow',traits:DEFAULT_TRAITS}).returning();await tx.insert(conversations).values({catId:cat!.id});}
   const token=randomBytes(32).toString('base64url');const [session]=await tx.insert(sessions).values({userId:user!.id,tokenHash:hashToken(token),expiresAt:sql`now()+${config.SESSION_DAYS}*interval '1 day'`}).returning();
   return {token,expires_at:session!.expiresAt,account_id:user!.id,cat:accountJSON(cat!)};
  });
  return result?c.json(result):c.json({error:{code:'apple_nonce_used',message:'请重新登录'}},401);
 });
 return routes;
}
