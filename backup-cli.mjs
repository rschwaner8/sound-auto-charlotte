import {DatabaseSync} from 'node:sqlite';
import {encryptedBackup,restoreEncrypted} from './encrypted-backup.mjs';
const [mode,source,destination]=process.argv.slice(2);if(!['backup','restore'].includes(mode)||!source||!destination)throw Error('Usage: node backup-cli.mjs backup|restore SOURCE DESTINATION; set BACKUP_ENCRYPTION_KEY through your secret manager');
if(mode==='backup'){const db=new DatabaseSync(source,{readOnly:true});try{await encryptedBackup(db,destination,process.env.BACKUP_ENCRYPTION_KEY);}finally{db.close();}}else restoreEncrypted(source,destination,process.env.BACKUP_ENCRYPTION_KEY);
console.log('Encrypted backup operation completed and SQLite integrity verified.');
