'use strict';
// Server-only Upstash persistence. Each account/session/event is stored as JSON.
// Atomic Redis operations allow multiple Vercel instances to share the same data.
const crypto = require('node:crypto');
class RedisStore {
  constructor(options = {}) {
    this.url = options.url || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    this.token = options.token || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    this.fetch = options.fetch || fetch;
    this.prefix = options.prefix || process.env.REDIS_KEY_PREFIX || '{hearnest}:';
    const missing=[];
    if(!this.url) missing.push('UPSTASH_REDIS_REST_URL (or KV_REST_API_URL)');
    if(!this.token) missing.push('UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN)');
    if(missing.length) throw Object.assign(Error('Missing Vercel environment variables: '+missing.join(', ')+'. Connect Upstash to this project, then redeploy.'),{code:'MISSING_REDIS_CONFIG',missing});
    try { if(new URL(this.url).protocol!=='https:') throw Error(); }
    catch { throw Object.assign(Error('The Redis REST URL must be a valid HTTPS URL from your Upstash database.'),{code:'INVALID_REDIS_URL'}); }
  }
  async command(...args) {
    let response;
    try {
      response = await this.fetch(this.url, {method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw Error();
      const result = await response.json();
      if (result.error) throw Error();
      return result.result;
    } catch { const error = Error('Account storage is unavailable. Check the Upstash connection in Vercel.'); error.status=503; throw error; }
  }
  async userById(id) { const row=await this.command('HGET',this.prefix+'users',id);return row?JSON.parse(row):null; }
  async userByEmail(email) { const id=await this.command('HGET',this.prefix+'emails',email);return id?this.userById(id):null; }
  async addUser(user) {
    // Reserve the email and account together; concurrent signups cannot duplicate it.
    const result=await this.command('EVAL',"if redis.call('HEXISTS',KEYS[1],ARGV[1]) == 1 then return 0 end redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]) redis.call('HSET',KEYS[2],ARGV[2],ARGV[3]) return 1",2,this.prefix+'emails',this.prefix+'users',user.email,user.id,JSON.stringify(user));
    if (result !== 1) throw Error('Duplicate email');
  }
  async session(tokenHash,now) {
    const raw=await this.command('GET',this.prefix+'session:'+tokenHash);if(!raw)return null;
    const session=JSON.parse(raw);if(session.expires_at<=now)return null;
    const user=await this.userById(session.user_id);return user?{...user,...session}:null;
  }
  async replaceSession(oldHash,session,now) {
    // Token rotation and expiry are applied atomically; only hashed tokens reach storage.
    await this.command('EVAL',"if ARGV[1] == '1' then redis.call('DEL',KEYS[1]) end redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]) return 1",2,this.prefix+'session:'+(oldHash||'unused'),this.prefix+'session:'+session.token_hash,oldHash?'1':'0',JSON.stringify(session),String(Math.max(1,session.expires_at-now)));
  }
  async removeSession(tokenHash) { await this.command('DEL',this.prefix+'session:'+tokenHash); }
  async addEvent(event) { await this.command('HSETNX',this.prefix+'events:'+event.user_id,event.event_id,JSON.stringify(event)); }
  async progressRows(userId) {
    const events=await this.command('HVALS',this.prefix+'events:'+userId),groups=new Map();
    for(const raw of events||[]){const event=JSON.parse(raw),key=event.stage+':'+event.sound_key;const row=groups.get(key)||{stage:event.stage,sound_key:event.sound_key,plays:0,last_completed:0};row.plays++;row.last_completed=Math.max(row.last_completed,event.completed_at);groups.set(key,row);}
    return [...groups.values()];
  }
  async checkRateLimit(key,limit) {
    const safe=crypto.createHash('sha256').update(key).digest('hex');
    const count=await this.command('EVAL',"local n=redis.call('INCR',KEYS[1]) if n == 1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end return n",1,this.prefix+'rate:'+safe,'900000');
    return count<=limit;
  }
  async ping() { return (await this.command('PING')) === 'PONG'; }
}
module.exports={RedisStore};
