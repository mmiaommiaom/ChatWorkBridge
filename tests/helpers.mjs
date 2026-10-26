import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Every test run owns fresh E-drive files. No login, historical evidence or
// previous application's data is needed, and test artifacts are not deleted.
export function testDirectory(label) {
  const project=fileURLToPath(new URL('..',import.meta.url));
  if(!/^E:[\\/]/i.test(project))throw Error('Tests currently require the checkout on E drive');
  const directory=path.join(project,'runtime','test-runs',label+'-'+randomUUID());
  fs.mkdirSync(directory,{recursive:true});
  return fs.realpathSync(directory);
}
