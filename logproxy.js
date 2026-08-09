#!/usr/bin/env node
// logproxy.js — logs payloads for a configurable list of upstream targets.
// Usage: 
// node logproxy.js --config targets.json
// node logproxy.js --config targets.json 2>&1 | tee proxy.log

////testing
//curl -s http://localhost:8787/openai/v1/chat/completions \
//    -H "Content-Type: application/json" \
//    -H "Authorization: Bearer sk-fake-or-real-key" \
//    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

////interesting blast of data here:
//curl -s http://localhost:8787/openrouter/v1/chat/completions \
//-H "Content-Type: application/json" \
//-H "Authorization: Bearer sk-or-your-real-key" \
//-d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

//!not working
const quiet = process.argv.includes('--quiet');
//node logproxy.js --config targets.json --quiet

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

//const usageLogPath = process.argv.includes('--usage-log')
//? process.argv[process.argv.indexOf('--usage-log') + 1]
//: 'usage.jsonl';

//uses path provided by cli option, or defaults to ~/.ai-session-inspector/usage.jsonl
const usageLogPath = process.argv.includes('--usage-log')
  ? process.argv[process.argv.indexOf('--usage-log') + 1]
  : path.join(os.homedir(), '.ai-session-inspector', 'usage.jsonl');

// Ensure directory exists
const usageDir = path.dirname(usageLogPath);
if (!fs.existsSync(usageDir)) {
  fs.mkdirSync(usageDir, { recursive: true });
}

function extractUsage(rawBody) {
const text = rawBody.toString();
try {
  const obj = JSON.parse(text);
  if (obj.usage) return { model: obj.model, usage: obj.usage };
} catch {}
let model, usage;
//this streaming payload digestion hasnt been tested yet
for (const line of text.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) continue;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') continue;
  try {
    const obj = JSON.parse(payload);
    if (obj.model) model = obj.model;
    if (obj.usage) usage = obj.usage;
  } catch {}
}
return { model, usage };
}

// OpenRouter's public /models endpoint doubles as a pricing table for most
// well-known models, even ones you're hitting directly (not through OpenRouter),
// since it lists provider-prefixed slugs like "openai/gpt-4o-mini";
//still we're kind of hoping the other providers dont subtly mess this up if we're crossing them
//theres no particular reason that they payload they return wil match our current schema
let modelPricing = {};
async function loadModelPricing() {
try {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  const data = await res.json();
  for (const m of data.data) {
//    modelPricing[m.id] = {
//      prompt: parseFloat(m.pricing?.prompt ?? '0'),
//      completion: parseFloat(m.pricing?.completion ?? '0'),
//    };
    modelPricing[m.id] = {
      prompt: parseFloat(m.pricing?.prompt ?? '0'),
      completion: parseFloat(m.pricing?.completion ?? '0'),
      context_length: m.context_length ?? null,
    };

  }
  console.log(`[pricing] loaded ${Object.keys(modelPricing).length} model prices`);
} catch (e) {
  console.error('[pricing] failed to load model pricing:', e.message);
}
}
loadModelPricing();
function lookupPricing(targetKey, model) {
if (!model) return null;
if (modelPricing[model]) return modelPricing[model];
const guess = `${targetKey}/${model}`; // heuristic: OpenRouter slugs are "<provider>/<model>"
if (modelPricing[guess]) return modelPricing[guess];
return null;
}

function loadConfig(path) {
const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
const targets = {};
for (const [key, url] of Object.entries(raw.targets)) targets[key] = new URL(url);
  //return { port: raw.listenPort || 8787, targets };
  return { port: raw.listenPort || 8787, targets, suppressed: raw.suppressed || {} };
}
const configPath = process.argv.includes('--config')
? process.argv[process.argv.indexOf('--config') + 1]
: './targets.json';
//let { port, targets } = loadConfig(configPath);
let { port, targets, suppressed } = loadConfig(configPath);

// Reload the target list on edit, no restart needed.
fs.watchFile(configPath, () => {
try {
    //({ targets } = loadConfig(configPath));
    ({ targets, suppressed } = loadConfig(configPath));
    console.log(`[config] reloaded ${Object.keys(targets).length} targets: ${Object.keys(targets).join(', ')}`);
} catch (e) {
    console.error('[config] reload failed:', e.message);
}


});
http.createServer((req, res) => {
const [, key, ...rest] = req.url.split('/'); // "/openai/v1/chat/completions"
const target = targets[key];

if (!target) {
    if (!quiet) console.warn(`[warn] unknown target key "${key}" (known: ${Object.keys(targets).join(', ')})`);
    return res.writeHead(404).end();
}

//if (!target) {
//    console.warn(`[warn] unknown target key "${key}" (known: ${Object.keys(targets).join(', ')})`);
//    return res.writeHead(404).end();
//}

//const targetQuiet = quiet || !!suppressed[key];
const targetQuiet = !!suppressed[key];

const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
const path = basePath + '/' + rest.join('/');

//const path = '/' + rest.join('/');
const chunks = [];
req.on('data', (c) => chunks.push(c));
req.on('end', () => {
    const body = Buffer.concat(chunks);
    //console.log(`\n=== [${key}] ${new Date().toISOString()} ${req.method} ${path} ===`);
    //try { console.log(JSON.stringify(JSON.parse(body), null, 2)); }
    //catch { console.log(body.toString()); }
    
    if (!targetQuiet) {
        console.log(`\n=== [${key}] ${new Date().toISOString()} ${req.method} ${path} ===`);
        try { console.log(JSON.stringify(JSON.parse(body), null, 2)); }
        catch { console.log(body.toString()); }
    }

    const client = target.protocol === 'https:' ? https : http;
    const upstream = client.request(
    //const upstream = https.request(
    //{ hostname: target.hostname, port: target.port || 443, path, method: req.method,
    { hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path, method: req.method,
        headers: { ...req.headers, host: target.hostname } },

    (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        const respChunks = [];
        upRes.on('data', (chunk) => {
            if (!targetQuiet) process.stdout.write(`[${key} resp] ${chunk}`);
            respChunks.push(chunk);
            res.write(chunk);
        });
        upRes.on('end', () => {
            res.end();
            const { model, usage } = extractUsage(Buffer.concat(respChunks));
            if (usage) {
                const pricing = lookupPricing(key, model);
                const computedCost = pricing
                    ? (usage.prompt_tokens || 0) * pricing.prompt + (usage.completion_tokens || 0) * pricing.completion
                    : null;
                    const record = {
                      timestamp: new Date().toISOString(),
                      target: key,
                      model,
                      context_length: pricing?.context_length ?? null,
                      prompt_tokens: usage.prompt_tokens,
                      completion_tokens: usage.completion_tokens,
                      total_tokens: usage.total_tokens,
                      reported_cost: usage.cost ?? null,
                      price_per_prompt_token: pricing?.prompt ?? null,
                      price_per_completion_token: pricing?.completion ?? null,
                      computed_cost: computedCost,
                  };
//                  const record = {
//                    timestamp: new Date().toISOString(),
//                    target: key,
//                    model,
//                    prompt_tokens: usage.prompt_tokens,
//                    completion_tokens: usage.completion_tokens,
//                    total_tokens: usage.total_tokens,
//                    reported_cost: usage.cost ?? null,
//                    price_per_prompt_token: pricing?.prompt ?? null,
//                    price_per_completion_token: pricing?.completion ?? null,
//                    computed_cost: computedCost,
//                };
                fs.appendFile(usageLogPath, JSON.stringify(record) + '\n', (err) => {
                    if (err) console.error('[usage-log] write failed:', err.message);
                });
            }
        });
    }
  

    //(upRes) => {
    //    res.writeHead(upRes.statusCode, upRes.headers);
    //    //upRes.on('data', (chunk) => { process.stdout.write(`[${key} resp] ${chunk}`); res.write(chunk); });
    //    upRes.on('data', (chunk) => { if (!targetQuiet) process.stdout.write(`[${key} resp] ${chunk}`); res.write(chunk); });
    //    upRes.on('end', () => res.end());
    //}

    );
    upstream.on('error', (e) => { console.error(`[${key}]`, e); res.writeHead(502).end(); });
    upstream.end(body);
});
}).listen(port, () => console.log(`logproxy listening on :${port}, targets: ${Object.keys(targets).join(', ')}, suppressed: ${Object.keys(suppressed).join(', ')}`));


