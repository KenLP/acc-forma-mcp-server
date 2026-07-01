// Adds the "forma" MCP server to Claude Desktop's config, reading creds from the
// repo .env. RUN THIS WHILE CLAUDE DESKTOP IS FULLY CLOSED (the app overwrites the
// config from memory while running, so an edit only sticks if done while it's closed).
const fs = require('fs');
const REPO = 'D:/AIProjects/acc-forma-mcp-server';
const cfgPath = 'C:/Users/lep/AppData/Roaming/Claude/claude_desktop_config.json';

// Parse .env (values never printed).
const env = {};
for (const line of fs.readFileSync(REPO + '/.env', 'utf8').split(/\r?\n/)) {
  if (line.trim().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const need = ['APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'SSA_ID', 'SSA_KEY_ID', 'SSA_KEY_PATH'];
const missing = need.filter((k) => !env[k]);
if (missing.length) { console.error('ERROR: missing in .env:', missing.join(', ')); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.forma = {
  command: 'node',
  args: [REPO.replace(/\//g, '\\') + '\\dist\\index.js'],
  env: {
    APS_CLIENT_ID: env.APS_CLIENT_ID,
    APS_CLIENT_SECRET: env.APS_CLIENT_SECRET,
    APS_AUTH_MODE: env.APS_AUTH_MODE || 'ssa',
    APS_REGION: env.APS_REGION || 'US',
    SSA_ID: env.SSA_ID,
    SSA_KEY_ID: env.SSA_KEY_ID,
    SSA_KEY_PATH: env.SSA_KEY_PATH,
  },
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log('OK: "forma" added. Servers now:', Object.keys(cfg.mcpServers).join(', '));
