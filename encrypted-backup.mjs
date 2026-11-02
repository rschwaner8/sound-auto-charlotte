import {DatabaseSync,backup} from 'node:sqlite';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
const magic=Buffer.from('DEALERDESK-BACKUP-v1\n');
function keyBytes(key){if(typeof key!=='string'||! /^[a-fA-F0-9]{64}$/.test(key))throw Error('Backup key must be exactly 32 random bytes encoded as hex');return Buffer.from(key,'hex');}
function integrity(file){const check=new DatabaseSync(file,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup database integrity failed');}finally{check.close();}}
export async function encryptedBackup(db,destination,key){
 const secret=keyBytes(key),absolute=path.resolve(destination),temporary=absolute+'.snapshot-'+randomBytes(8).toString('hex'),staged=absolute+'.partial-'+randomBytes(8).toString('hex');let madeSnapshot=false,madeStage=false;
 try{await backup(db,temporary);madeSnapshot=true;integrity(temporary);const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce),ciphertext=Buffer.concat([cipher.update(readFileSync(temporary)),cipher.final()]);const payload=Buffer.concat([magic,nonce,cipher.getAuthTag(),ciphertext]);writeFileSync(staged,payload,{flag:'wx',mode:0o600});madeStage=true;
 // A unique destination is required. Existing snapshots must not be overwritten.
 const {copyFileSync,constants}=await import('node:fs');copyFileSync(staged,absolute,constants.COPYFILE_EXCL);return {path:absolute,bytes:payload.length};
 }finally{if(madeSnapshot)unlinkSync(temporary);if(madeStage)unlinkSync(staged);secret.fill(0);}
}
export function restoreEncrypted(source,destination,key){
 const secret=keyBytes(key),payload=readFileSync(source);let created=false;try{if(payload.length<magic.length+28||!payload.subarray(0,magic.length).equals(magic))throw Error('Unsupported backup format');const at=magic.length,decipher=createDecipheriv('aes-256-gcm',secret,payload.subarray(at,at+12));decipher.setAuthTag(payload.subarray(at+12,at+28));const plaintext=Buffer.concat([decipher.update(payload.subarray(at+28)),decipher.final()]);writeFileSync(destination,plaintext,{flag:'wx',mode:0o600});created=true;integrity(destination);return {path:path.resolve(destination)};}catch(e){if(created)unlinkSync(destination);throw e;}finally{secret.fill(0);}}
