import {scryptSync,timingSafeEqual,randomBytes} from 'node:crypto';
const options={N:16384,r:8,p:1,maxmem:64*1024*1024};
export function passwordDigest(password,salt=randomBytes(16).toString('hex')){
 if(typeof password!=='string'||password.length<16||password.length>256)throw Error('Use a password between 16 and 256 characters');
 if(!/^[a-f0-9]{32}$/.test(salt))throw Error('Invalid salt');
 return `scrypt$${salt}$${scryptSync(password,salt,64,options).toString('hex')}`;
}
export function verifyPassword(password,digest){
 if(typeof password!=='string'||password.length>256||typeof digest!=='string')return false;
 const parts=digest.split('$');if(parts.length!==3||parts[0]!=='scrypt'||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{128}$/.test(parts[2]))return false;
 const expected=Buffer.from(parts[2],'hex'),actual=scryptSync(password,parts[1],64,options);return timingSafeEqual(expected,actual);
}
