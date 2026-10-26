import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {assertControlledPath} from '../src/local-config.mjs';

// Manual transport probe: starts only this repository's MCP process.
// No model messages, browser actions or arbitrary shell commands are sent.
if(!process.argv.includes('--live'))throw Error('Manual transport probe: add --live to start a local MCP child process. No model is called.');
const root=assertControlledPath(fs.realpathSync(new URL('..',import.meta.url)));
const workspace=path.join(root,'runtime','test-runs','mcp-boundary-'+randomUUID());
fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(path.join(root,'data'),{recursive:true});
const configFile=path.join(workspace,'policy.json');
fs.writeFileSync(configFile,JSON.stringify({workspace:fs.realpathSync(workspace),browserTargetId:'synthetic-target',browserUrl:'http://127.0.0.1/synthetic-test'},null,2));
const client=new Client({name:'bridge-boundary-test',version:'1.0.0'});
const env=Object.fromEntries(Object.entries(process.env).filter(([,value])=>typeof value==='string'));
Object.assign(env,{WB_BRIDGE_CAPABILITY_CONFIG:configFile,TEMP:workspace,TMP:workspace});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'scripts','capability-mcp.mjs')],cwd:root,env});
try{
 await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,4);
 const pathError=await client.callTool({name:'write_file',arguments:{path:'../outside.txt',content:'must not write'}});assert.equal(pathError.isError,true);assert.match(pathError.content[0].text,/PATH_DENIED/);
 const commandError=await client.callTool({name:'run_command',arguments:{command:'powershell'}});assert.equal(commandError.isError,true);assert.match(commandError.content[0].text,/COMMAND_DENIED/);
 const result={testedAt:new Date().toISOString(),mcpTransport:true,toolCount:4,pathEscapeBlocked:true,arbitraryCommandBlocked:true,caller:'independent_test_client; no model involvement',osSandbox:false};fs.writeFileSync(path.join(workspace,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await client.close();}
