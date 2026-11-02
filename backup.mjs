import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
const dest=process.argv[2];if(!dest)throw Error('Usage: node backup.mjs /offsite-mounted-path/snapshot.db');const db=new DatabaseSync(process.env.DB_PATH||'data/dealerdesk.db');await backup(db,dest);const check=new DatabaseSync(dest,{readOnly:true});if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup integrity failed');check.close();db.close();console.log('Backup integrity verified. Encrypt and copy off-site; retain according to runbook.');
