import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {testDirectory} from './helpers.mjs';
import {loadConfig,assertControlledPath,projectRoot,expectedRendererPrefix,dataDriveForPath,validateExecutable} from '../src/local-config.mjs';

const directory=testDirectory('local-config');
const projectDrive=dataDriveForPath(projectRoot);
const otherDrive=projectDrive==='D:'?'F:':'D:';
const base={workbuddyExe:path.join(directory,'SyntheticWorkBuddy.exe'),chromeExe:path.join(directory,'SyntheticChrome.exe')};
let fixtureNumber=0;
function fixture(patch={}){
  const file=path.join(directory,'fixture-'+(++fixtureNumber)+'.json');
  fs.writeFileSync(file,JSON.stringify({...base,...patch}));
  return file;
}
const load=patch=>loadConfig({configPath:fixture(patch)});
function invalid(patch,pattern){assert.throws(()=>load(patch),pattern);}

test('missing local settings fail with an actionable code without creating the file',()=>{
  const configPath=path.join(directory,'not-created.json');
  assert.throws(()=>loadConfig({configPath}),{code:'LOCAL_CONFIG_MISSING'});
  assert.equal(fs.existsSync(configPath),false);
});

test('controlled data defaults to the checkout drive and mismatching configured drives are rejected',()=>{
  assert.notEqual(projectDrive,'C:');
  assert.equal(load({}).dataDrive,projectDrive);
  assert.equal(load({dataDrive:projectDrive.toLowerCase()}).dataDrive,projectDrive);
  assert.equal(assertControlledPath(directory),directory);
  assert.throws(()=>assertControlledPath(otherDrive+'/synthetic-bridge-data'),new RegExp(projectDrive));
  assert.throws(()=>assertControlledPath('relative-data'),/绝对路径/);
  invalid({dataDrive:otherDrive},/dataDrive/);
  invalid({dataDrive:'C:'},/dataDrive/);
  invalid({workbuddyExe:'relative-app.exe'},/绝对路径/);
});

test('non-C Windows drive inference is portable without writing to other drives',()=>{
  for(const [value,drive] of [['D:/My Apps/测试','D:'],['e:\\Bridge','E:'],['F:/Portable/Bridge','F:']])assert.equal(dataDriveForPath(value),drive);
  for(const value of ['C:/data','C:\\data','D:relative','relative','\\\\server\\share\\data','/tmp/data'])assert.throws(()=>dataDriveForPath(value));
  assert.throws(()=>assertControlledPath('\\\\server\\share\\data'),/绝对路径/);
});

test('C data and a checkout-drive junction whose missing descendants resolve to C are refused',()=>{
  assert.throws(()=>assertControlledPath('C:/synthetic-bridge-data'),/C 盘/);
  invalid({workbuddyProfile:'C:/synthetic-profile'},/C 盘/);
  // The junction itself is created only inside this test's own directory. Its
  // target is inspected read-only; no file or directory is created on C.
  const link=path.join(directory,'c-drive-junction');
  fs.symlinkSync('C:\\',link,'junction');
  assert.throws(()=>assertControlledPath(path.join(link,'synthetic-missing','child')),/C 盘/);
  assert.throws(()=>load({workbuddyProfile:path.join(link,'synthetic-profile')}),/C 盘/);
});

test('normal-profile config requires a profile and remains inside its configured scope',()=>{
  const profile=path.join(directory,'synthetic-profile');
  invalid({allowNormalProfile:true},/workbuddyProfile/);
  invalid({workbuddyConfigDir:path.join(directory,'orphan-config')},/workbuddyProfile/);
  invalid({workbuddyProfile:profile,workbuddyConfigDir:path.join(directory,'sibling-profile')},/必须位于/);
  invalid({workbuddyProfile:profile,workbuddyConfigDir:directory},/必须位于/);
  const result=load({workbuddyProfile:profile});
  assert.equal(result.workbuddyConfigDir,path.join(profile,'.workbuddy-ai'));
  assert.equal(fs.existsSync(profile),false);
});

test('authorization is false by default and non-boolean authorization is rejected',()=>{
  const result=load({});
  assert.equal(result.allowNormalProfile,false);
  assert.equal(result.allowNativeRuntimeRecords,false);
  assert.equal(result.workbuddyProfile,null);
  for(const name of ['allowNormalProfile','allowNativeRuntimeRecords']){
    for(const value of ['true',1,{},null])invalid({[name]:value},/true 或 false/);
  }
});

test('duplicate, unknown, privileged and non-integer ports are rejected',()=>{
  invalid({ports:{workbuddy:21000,gpt:21000}},/不能相同/);
  for(const port of [80,65536,21000.5,'21000',null])invalid({ports:{dashboard:port}},/无效端口/);
  invalid({ports:{unexpected:21000}},/无效端口/);
});

test('inherited object names cannot be added as configured service ports',()=>{
  for(const name of ['constructor','toString','hasOwnProperty','valueOf','__proto__']){
    const ports=JSON.parse('{"'+name+'":24000}');
    assert.equal(Object.hasOwn(ports,name),true);
    invalid({ports},/无效端口/);
  }
});

test('valid custom ports and synthetic app/profile paths load without launching applications',()=>{
  const workbuddyProfile=path.join(directory,'custom-profile');
  const workbuddyConfigDir=path.join(workbuddyProfile,'settings');
  const ports={workbuddy:23010,gpt:23011,dashboard:23012,normalWorkbuddy:23013};
  const result=load({workbuddyProfile,workbuddyConfigDir,ports,allowNormalProfile:true,allowNativeRuntimeRecords:true});
  assert.equal(result.workbuddyExe,base.workbuddyExe);
  assert.equal(result.chromeExe,base.chromeExe);
  assert.equal(result.workbuddyProfile,workbuddyProfile);
  assert.equal(result.workbuddyConfigDir,workbuddyConfigDir);
  assert.deepEqual(result.ports,ports);
  assert.equal(result.allowNormalProfile,true);
  assert.equal(result.allowNativeRuntimeRecords,true);
  assert.equal(result.nodeExe,process.execPath);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.ports),true);
  const expected=new URL('resources/app.asar/renderer/index.html',new URL('./',new URL('file:///'+base.workbuddyExe.replaceAll('\\','/')))).href;
  assert.equal(expectedRendererPrefix(result),expected);
  assert.equal(fs.existsSync(workbuddyProfile),false);
  assert.equal(fs.existsSync(base.workbuddyExe),false);
});

test('existing fake EXE files and the wrong application are rejected before launch',()=>{
  const target=path.join(directory,'Chrome.exe');fs.writeFileSync(target,'synthetic placeholder');
  assert.throws(()=>validateExecutable(target,'chromeExe'),/不是有效/);
  assert.throws(()=>validateExecutable(target,'workbuddyExe'),/实际应用/);
  const pe=Buffer.alloc(128);pe.write('MZ');pe.writeUInt32LE(64,60);pe.set([0x50,0x45,0,0],64);fs.writeFileSync(target,pe);
  assert.equal(validateExecutable(target,'chromeExe'),target);
  pe.writeUInt32LE(10000,60);fs.writeFileSync(target,pe);
  assert.throws(()=>validateExecutable(target,'chromeExe'),/程序头无效/);
});

test('daily mode must be explicit and authorized, and is not inferred from advanced paths',()=>{
  const profile=path.join(directory,'mode-profile');
  assert.equal(load({allowNormalProfile:true,workbuddyProfile:profile}).workbuddyMode,'test');
  invalid({workbuddyMode:'unknown'},/workbuddyMode/);
  invalid({workbuddyMode:'normal'},/明确允许/);
  assert.equal(load({workbuddyMode:'normal',allowNormalProfile:true,workbuddyProfile:profile}).workbuddyMode,'normal');
});

test('dangling junctions are rejected before any destination creation',()=>{
  const target=path.join(directory,'missing-junction-target');
  const link=path.join(directory,'dangling-junction');fs.symlinkSync(target,link,'junction');
  assert.equal(fs.existsSync(link),false);assert.equal(fs.lstatSync(link).isSymbolicLink(),true);
  assert.throws(()=>assertControlledPath(path.join(link,'child')),/无法解析|联接/);
  assert.equal(fs.existsSync(target),false);
});
