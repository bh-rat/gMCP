import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { McpClient } from '../../ts/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3001;

type ClientInfo = {
  address: string;
  options?: { metadata?: Record<string, string> };
};

const clients = new Map<string, ClientInfo>();

const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url && req.url.startsWith('/api/')) {
    await handleApiRequest(req, res);
    return;
  }

  // Serve static files from Vite build
  let filePath: string;
  let ext: string;
  let contentType: string;

  if (req.url === '/' || req.url === '/index.html') {
    // Serve the main index.html from dist directory
    filePath = path.join(__dirname, 'index.html');
    ext = '.html';
    contentType = mimeTypes[ext];
  } else if (req.url?.startsWith('/assets/')) {
    // Serve assets from dist/assets directory
    filePath = path.join(__dirname, req.url);
    ext = path.extname(filePath).toLowerCase();
    contentType = mimeTypes[ext] || 'application/octet-stream';
  } else {
    // For any other path, serve index.html (SPA routing)
    filePath = path.join(__dirname, 'index.html');
    ext = '.html';
    contentType = mimeTypes[ext];
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

async function readBody<T = any>(req: http.IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body ? JSON.parse(body) : ({} as any);
}

async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const endpoint = (req.url || '').split('/')[2];
  try {
    const data = req.method === 'POST' ? await readBody(req) : {};
    switch (endpoint) {
      case 'connect':
        await handleConnect(data, res);
        break;
      case 'disconnect':
        await handleDisconnect(data, res);
        break;
      case 'list-tools':
        await handleListTools(data, res);
        break;
      case 'call-tool':
        await handleCallTool(data, res);
        break;
      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API not found' }));
    }
  } catch (e: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
}

async function handleConnect(data: any, res: http.ServerResponse) {
  const { address, useAuth, jwtToken } = data;
  const serverAddress = address || 'localhost:8000';
  const options: ClientInfo['options'] = useAuth === 'jwt' && jwtToken ? { metadata: { authorization: `Bearer ${jwtToken}` } } : undefined;
  const client = new McpClient(serverAddress, options);
  await client.connect();
  // Use reflection: request FileDescriptorSet via gRPC reflection
  const authHeader = useAuth === 'jwt' && jwtToken ? `Bearer ${jwtToken}` : undefined;
  const fdsBytes = await reflectDescriptorSet(serverAddress, authHeader);
  const { serverId, serverVersion } = readServerMetaFromFdsBytes(fdsBytes);
  const reflectionInfo = {
    meta: {
      serverId,
      serverVersion,
      services: ['mcp.v0.McpService'],
      methods: { 'mcp.v0.McpService': ['ListTools', 'CallTool'] }
    }
  };
  client.close();
  const clientId = `ui-${Date.now()}`;
  clients.set(clientId, { address: serverAddress, options });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, clientId, reflectionInfo }));
}

async function handleDisconnect(data: any, res: http.ServerResponse) {
  const { clientId } = data;
  clients.delete(clientId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

async function handleListTools(data: any, res: http.ServerResponse) {
  const { clientId, useAuth, jwtToken } = data;
  const info = clients.get(clientId);
  if (!info) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not connected' }));
    return;
  }
  // Use provided auth if available, otherwise fall back to stored options
  const opts = (useAuth === 'jwt' && jwtToken) ? { metadata: { authorization: `Bearer ${jwtToken}` } } : info.options;
  const client = new McpClient(info.address, opts);
  await client.connect();
  const tools = await client.discover();
  // Derive minimal JSON schema from known request types
  const withSchemas = tools.map((t: any) => ({
    ...t,
    inputSchema: deriveSchemaForInput(t.inputType)
  }));
  client.close();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, tools: withSchemas }));
}

async function handleCallTool(data: any, res: http.ServerResponse) {
  const { clientId, toolName, args, useAuth, jwtToken } = data;
  console.log('🔍 handleCallTool received data:', JSON.stringify(data, null, 2));
  console.log('🔍 handleCallTool args specifically:', JSON.stringify(args, null, 2));
  const info = clients.get(clientId);
  if (!info) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not connected' }));
    return;
  }
  // Use provided auth if available, otherwise fall back to stored options
  const opts = (useAuth === 'jwt' && jwtToken) ? { metadata: { authorization: `Bearer ${jwtToken}` } } : info.options;
  const client = new McpClient(info.address, opts);
  await client.connect();
  const validationErrors = await client.validateInputs(toolName, args || {});
  console.log('🔍 validation errors:', validationErrors);
  if (validationErrors.length > 0) {
    client.close();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: validationErrors[0], validation_errors: validationErrors }));
    return;
  }
  const results: any[] = [];
  for await (const chunk of client.call(toolName, args)) {
    results.push(chunk);
    if (chunk.final) break;
  }
  client.close();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, results }));
}

server.listen(PORT, () => {
  console.log(`UI server running at http://localhost:${PORT}`);
});

// --- Reflection helpers (decode mcp_server_meta and basic schema) ---

async function reflectDescriptorSet(address: string, authHeader?: string): Promise<Uint8Array[]> {
  console.log(`🔍 reflectDescriptorSet: connecting to ${address} with auth: ${authHeader ? 'YES' : 'NO'}`);
  const REFLECTION_PROTO = `
    syntax = "proto3";
    package grpc.reflection.v1alpha;
    service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
    message ServerReflectionRequest { string host = 1; oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; ExtensionRequest file_containing_extension = 5; string all_extension_numbers_of_type = 6; string list_services = 7; } }
    message ExtensionRequest { string containing_type = 1; int32 extension_number = 2; }
    message ServerReflectionResponse { string valid_host = 1; ServerReflectionRequest original_request = 2; oneof message_response { FileDescriptorResponse file_descriptor_response = 4; ExtensionNumberResponse all_extension_numbers_response = 5; ListServiceResponse list_services_response = 6; ErrorResponse error_response = 7; } }
    message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
    message ExtensionNumberResponse { string base_type_name = 1; repeated int32 extension_number = 2; }
    message ListServiceResponse { repeated ServiceResponse service = 1; }
    message ServiceResponse { string name = 1; }
    message ErrorResponse { int32 error_code = 1; string error_message = 2; }
  `;
  const os = await import('os');
  const tmpPath = await import('path');
  const tmpFile = tmpPath.join(os.tmpdir(), `reflection_${Date.now()}.proto`);
  fs.writeFileSync(tmpFile, REFLECTION_PROTO);
  const pkgDef = protoLoader.loadSync(tmpFile, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  fs.unlinkSync(tmpFile);
  const refPkg = (grpc.loadPackageDefinition(pkgDef) as any).grpc.reflection.v1alpha;
  console.log(`📡 Creating reflection client for ${address}`);
  const client = new refPkg.ServerReflection(address, grpc.credentials.createInsecure());
  const md = new grpc.Metadata();
  if (authHeader) {
    console.log(`🔐 Adding authorization header: ${authHeader.substring(0, 20)}...`);
    md.set('authorization', authHeader);
  }
  console.log(`📞 Starting reflection call`);
  const call = client.ServerReflectionInfo(md);
  const protos: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    call.on('data', (resp: any) => {
      console.log(`📡 Got reflection data response`);
      const kind = resp.message_response;
      console.log(`📋 Response type: ${kind}`);
      if (kind === 'file_descriptor_response' && resp.file_descriptor_response) {
        const count = resp.file_descriptor_response.file_descriptor_proto.length;
        console.log(`✅ Got ${count} file descriptors`);
        for (const b of resp.file_descriptor_response.file_descriptor_proto) {
          protos.push(new Uint8Array(b));
        }
      } else if (kind === 'error_response' && resp.error_response) {
        const errorMsg = resp.error_response.error_message;
        console.log(`❌ Reflection error: ${errorMsg}`);
        if (protos.length === 0) {
          return reject(new Error(errorMsg));
        }
      } else {
        console.log(`📋 Other response type: ${kind}`);
      }
    });
    call.on('error', (e: any) => {
      console.log(`❌ Reflection call error: ${e.message}`);
      const msg = (e && e.message) || '';
      if (protos.length > 0 && /RST_STREAM|CANCEL|code 1/i.test(msg)) {
        console.log(`✅ Ignoring ${msg} - got ${protos.length} descriptors`);
        return resolve();
      }
      reject(e);
    });
    call.on('end', () => {
      console.log(`🔚 Reflection call ended - collected ${protos.length} descriptors`);
      resolve();
    });
    // Request both the MCP service file and the server metadata file
    console.log(`📤 Requesting file_containing_symbol: mcp.v0.McpService`);
    call.write({ host: '', file_containing_symbol: 'mcp.v0.McpService' });
    console.log(`📤 Requesting file_by_filename: internal/meta_anchor.proto`);
    call.write({ host: '', file_by_filename: 'internal/meta_anchor.proto' });
    console.log(`📤 Ending reflection call`);
    call.end();
  });
  return protos;
}

function readServerMetaFromFdsBytes(fileDescriptorProtos: Uint8Array[]): { serverId: string; serverVersion: string } {
  for (const fdp of fileDescriptorProtos) {
    const meta = extractServerMetaFromFileDescriptorProto(fdp);
    if (meta.serverId || meta.serverVersion) return meta;
  }
  return { serverId: '', serverVersion: '' };
}

function extractServerMetaFromFileDescriptorProto(buf: Uint8Array): { serverId: string; serverVersion: string } {
  // Find field 8 (options), then inside options find extension 777001 (len-delimited), decode payload as two strings (1,2)
  let off = 0;
  while (off < buf.length) {
    const [tag, o1] = readVarint(buf, off); off = o1;
    const fieldNo = tag >>> 3; const wt = tag & 7;
    if (fieldNo === 8 && wt === 2) {
      const [len, o2] = readVarint(buf, off); off = o2;
      const end = off + len;
      const ext = findExtension777001(buf.subarray(off, end));
      if (ext) return decodeServerMeta(ext);
      off = end;
    } else {
      off = skipField(buf, off, wt);
    }
  }
  return { serverId: '', serverVersion: '' };
}

function findExtension777001(opts: Uint8Array): Uint8Array | null {
  let off = 0;
  while (off < opts.length) {
    const [tag, o1] = readVarint(opts, off); off = o1;
    const fieldNo = tag >>> 3; const wt = tag & 7;
    if (fieldNo === 777001 && wt === 2) {
      const [len, o2] = readVarint(opts, off); off = o2;
      const end = off + len;
      return opts.subarray(off, end);
    }
    off = skipField(opts, off, wt);
  }
  return null;
}

function decodeServerMeta(b: Uint8Array): { serverId: string; serverVersion: string } {
  let off = 0; let serverId = ''; let serverVersion = '';
  while (off < b.length) {
    const [tag, o1] = readVarint(b, off); off = o1;
    const fn = tag >>> 3; const wt = tag & 7;
    if (wt !== 2) { off = skipField(b, off, wt); continue; }
    const [len, o2] = readVarint(b, off); off = o2;
    const end = off + len;
    const str = new TextDecoder().decode(b.subarray(off, end));
    if (fn === 1) serverId = str; else if (fn === 2) serverVersion = str;
    off = end;
  }
  return { serverId, serverVersion };
}

function readVarint(buf: Uint8Array, off: number): [number, number] {
  let x = 0; let s = 0; let o = off;
  while (o < buf.length) {
    const b = buf[o++];
    x |= (b & 0x7f) << s; s += 7;
    if ((b & 0x80) === 0) break;
  }
  return [x >>> 0, o];
}

function skipField(buf: Uint8Array, off: number, wt: number): number {
  switch (wt) {
    case 0: { const [, o] = readVarint(buf, off); return o; }
    case 1: return off + 8;
    case 2: { const [l, o] = readVarint(buf, off); return o + l; }
    case 5: return off + 4;
    default: return off;
  }
}

function deriveSchemaForInput(typeName: string): any {
  return deriveSchemaFromType(typeName);
}

function deriveSchemaForTool(toolName: string): any {
  if (toolName === 'get_weather') {
    return deriveSchemaFromType('examples.weather.GetWeatherRequest');
  }
  return { type: 'object', properties: {}, required: [] };
}

function deriveSchemaFromType(typeName: string): any {
  // Provide a basic schema for known example; extensible for future types
  if (typeName === 'examples.weather.GetWeatherRequest') {
    return {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City or place' },
        units: { type: 'string', enum: ['metric', 'imperial'], description: 'Unit system' }
      },
      required: ['location']
    };
  }
  return { type: 'object', properties: {}, required: [] };
}
