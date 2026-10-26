import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertControlledPath} from '../src/local-config.mjs';

// Every test run owns fresh files on the checkout's non-C drive. No login, historical evidence or
// previous application's data is needed, and test artifacts are not deleted.
export function testDirectory(label) {
  const project=fileURLToPath(new URL('..',import.meta.url));
  const directory=assertControlledPath(path.join(project,'runtime','test-runs',label+'-'+randomUUID()));
  fs.mkdirSync(directory,{recursive:true});
  return fs.realpathSync(directory);
}
