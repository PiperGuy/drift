/** Entry point: `<app binary> mcp.js --db <path to plumbr.db>` on stdio. See ./server.ts. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { PRODUCT } from '@shared/product'
import { createMcpServer } from './server'

const dbArg = process.argv.indexOf('--db')
const dbPath = dbArg > -1 ? process.argv[dbArg + 1] : null
if (!dbPath) {
  process.stderr.write(`usage: ${PRODUCT} MCP --db <path to plumbr.db>\n`)
  process.exit(2)
}

void createMcpServer(dbPath).connect(new StdioServerTransport())
