import {passwordDigest} from './auth.mjs';
import {timingSafeEqual} from 'node:crypto';

export function adminSetup(db, env) {
  db.exec('CREATE TABLE IF NOT EXISTS admin_setup (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const stored = () => db.prepare('SELECT digest FROM admin_setup WHERE id=1').get()?.digest;
  const digest = () => env.ADMIN_PASSWORD_DIGEST || stored();
  const attempts = new Map();
  return {digest, async handle(req, res, path) {
    if (path !== '/api/setup') return false;
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, data) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(data));return true;};
    if (digest()) return reply(409, {error:'Admin setup is already complete. Sign in at /ops.'});
    const token = env.ADMIN_SETUP_TOKEN || '';
    const expiry = Date.parse(env.ADMIN_SETUP_EXPIRES_AT || '');
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token) || !Number.isFinite(expiry) || expiry <= Date.now()) return reply(403, {error:'Setup is disabled or expired. The account owner must configure a temporary setup code and expiry in Render.'});
    if (req.method !== 'POST') return reply(405, {error:'Use the password setup form.'});
    if (req.headers.origin !== env.PUBLIC_ORIGIN || req.headers['content-type']?.split(';')[0] !== 'application/json') return reply(403,{error:'Setup request rejected.'});
    const now = Date.now();
    // Global bound avoids trusting forwarded IP headers and limits expensive hashing.
    const bucket = Math.floor(now / 900000);
    for (const k of attempts.keys()) if (k !== bucket) attempts.delete(k);
    attempts.set(bucket, (attempts.get(bucket)||0)+1);
    if (attempts.get(bucket)>10) return reply(429,{error:'Too many setup attempts. Try again in 15 minutes.'});
    let raw = '';
    for await (const chunk of req) {raw += chunk;if(Buffer.byteLength(raw)>4096)return reply(413,{error:'Request too large.'});}
    let p;try {p=JSON.parse(raw);} catch{return reply(400,{error:'Invalid request.'});}
    const supplied = Buffer.from(typeof p.token==='string'?p.token:'');
    const expected = Buffer.from(token);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(403,{error:'Incorrect setup code.'});
    if(typeof p.password!=='string'||p.password.length<16||p.password.length>256||p.password!==p.confirm)return reply(400,{error:'Use matching passwords of 16–256 characters.'});
    const hashed = passwordDigest(p.password);
    const result=db.prepare('INSERT OR IGNORE INTO admin_setup (id,digest,created_at) VALUES(1,?,?)').run(hashed,now);
    if(!result.changes)return reply(409,{error:'Setup already completed.'});
    return reply(201,{ok:true});
  }};
}
