import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {auditedCapability} from '../src/capability-tools.mjs';
const server=new McpServer({name:'bridge-test',version:'0.1.0'});
const definitions={read_file:{path:z.string()},write_file:{path:z.string(),content:z.string()},run_command:{command:z.string()},browser_action:{action:z.enum(['read','fill','click']),text:z.string().optional()}};
for(const [name,inputSchema] of Object.entries(definitions))server.registerTool(name,{description:{read_file:'Read only note.txt or input.json in the dedicated non-C capability test sandbox.',write_file:'Write only note.txt or input.json in the dedicated non-C capability test sandbox.',run_command:'Execute only node_version (real Node --version). All other commands rejected.',browser_action:'Operate only the fixed local test page: read state, fill entry text, click Apply. No arbitrary URL or selectors.'}[name],inputSchema},async args=>{try{return{content:[{type:'text',text:JSON.stringify(await auditedCapability(name,args))}]};}catch(e){return{isError:true,content:[{type:'text',text:e.message}]};}});
await server.connect(new StdioServerTransport());
