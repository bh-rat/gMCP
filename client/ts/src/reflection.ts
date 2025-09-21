import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as pb from 'protobufjs';
import { FileDescriptorProto, DescriptorProto as GDescriptorProto, FieldDescriptorProto as GFieldDescriptorProto } from 'google-protobuf/google/protobuf/descriptor_pb';
import { FieldRulesSchema } from './generated/validate/validate_pb';
import { fromBinary } from '@bufbuild/protobuf';
const pbDescriptor = require('protobufjs/ext/descriptor');
// @ts-ignore: patch protobufjs Root with fromDescriptor if available
try { require('protobufjs/ext/descriptor'); } catch {}

export interface ServerMeta {
  serverId: string;
  serverVersion: string;
  services: string[];
  methods: { [serviceName: string]: string[] };
}

export interface DescriptorInfo {
  meta: ServerMeta;
  available: boolean;
  reflectionData: any;
}

export class DescriptorCache {
  private cache = new Map<string, DescriptorInfo>();
  private rootCache = new Map<string, pb.Root>();
  private pgvCache = new Map<string, Record<string, Record<string, any>>>();

  private getCacheKey(address: string, packageVersion: string): string {
    return `${address}:${packageVersion}`;
  }

  async getDescriptors(
    address: string,
    metadata?: grpc.Metadata,
    packageVersion = 'mcp.v0'
  ): Promise<DescriptorInfo> {
    const cacheKey = this.getCacheKey(address, packageVersion);

    let cached = this.cache.get(cacheKey);
    if (!cached) {

      try {
        const services = await this.listServicesUsingReflection(address, metadata);
        const serverMeta = await this.getServerMetaUsingReflection(address, metadata, services);

        cached = {
          meta: serverMeta,
          available: true,
          reflectionData: { services }
        };


      } catch (error: any) {
       cached = {
         meta: {
           serverId: 'unknown-fallback',
           serverVersion: '1.0.0',
            services: ['mcp.v0.McpService'],
            methods: { 'mcp.v0.McpService': ['ListTools'] }
          },
          available: false,
          reflectionData: null
        };
      }

      this.cache.set(cacheKey, cached);
    }

    return cached;
  }

  private async listServicesUsingReflection(address: string, metadata?: grpc.Metadata): Promise<string[]> {
    return new Promise((resolve, reject) => {

      try {
        const reflectionProto = this.createReflectionPackageDefinition() as any;
        const client = new reflectionProto.grpc.reflection.v1alpha.ServerReflection(
          address,
          grpc.credentials.createInsecure()
        );


        const call = client.ServerReflectionInfo(metadata || new grpc.Metadata());

        call.on('data', (response: any) => {

          if (response.list_services_response) {
            const services = response.list_services_response.service.map((svc: any) => svc.name);
            call.end();
            resolve(services);
          }
        });

        call.on('error', (error: any) => {
          call.end();
          reject(error);
        });

        call.on('end', () => {});

        // Send list services request
        call.write({
          host: '',
          list_services: ''
        });

        // Set timeout
        setTimeout(() => {
          call.cancel();
          reject(new Error('Reflection timeout'));
        }, 5000);

      } catch (error: any) {
        reject(error);
      }
    });
  }

  private async getServerMetaUsingReflection(address: string, metadata?: grpc.Metadata, services?: string[]): Promise<ServerMeta> {
    // For now, return basic metadata since we're using dynamic discovery
    // This could be enhanced to actually query server metadata via reflection
    const methods = this.extractMethods(services || ['mcp.v0.McpService']);

    return {
      serverId: 'dynamic-server',
      serverVersion: '1.0.0',
      services: services || ['mcp.v0.McpService'],
      methods
    };
  }

  private extractMethods(services: string[]): { [serviceName: string]: string[] } {
    const methods: { [serviceName: string]: string[] } = {};

    for (const service of services) {
      if (service === 'mcp.v0.McpService') {
        methods[service] = ['ListTools'];
      } else if (service === 'grpc.reflection.v1alpha.ServerReflection') {
        methods[service] = ['ServerReflectionInfo'];
      }
    }

    return methods;
  }

  clearCache(): void {
    this.cache.clear();
  }

  // --- New: Dynamic descriptor fetching and Root building ---

  async getTypesRoot(address: string, fullyQualifiedTypeNames: string[], metadata?: grpc.Metadata): Promise<pb.Root> {
    const key = `${address}`;
    const existing = this.rootCache.get(key);
    if (existing) return existing;

    const unique = Array.from(new Set(fullyQualifiedTypeNames.filter(Boolean)));
    if (unique.length === 0) {
      const emptyRoot = new pb.Root();
      this.rootCache.set(key, emptyRoot);
      return emptyRoot;
    }

    const fdpBytes = await this.fetchFileDescriptors(address, unique, metadata);
    const descriptorSetObj = this.buildDescriptorSetObject(fdpBytes);

    // Build protobufjs Root using descriptor extension if available; fallback to empty Root
    const RootAny: any = pb.Root as any;
    const root: pb.Root = typeof RootAny.fromDescriptor === 'function'
      ? (RootAny.fromDescriptor(descriptorSetObj) as pb.Root)
      : new pb.Root();
    root.resolveAll();

    this.rootCache.set(key, root);
    return root;
  }

  buildCodec(root: pb.Root) {
    return new DynamicProtoCodec(root);
  }

  private async fetchFileDescriptors(address: string, symbols: string[], metadata?: grpc.Metadata): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      try {
        const reflectionProto = this.createReflectionPackageDefinition();
        const client = new (reflectionProto as any).grpc.reflection.v1alpha.ServerReflection(
          address,
          grpc.credentials.createInsecure()
        );

        const call = client.ServerReflectionInfo(metadata || new grpc.Metadata());
        const out: Uint8Array[] = [];
        const seen = new Set<string>();

        call.on('data', (response: any) => {
          const fdr = response.file_descriptor_response;
          if (fdr?.file_descriptor_proto) {
            for (const buf of fdr.file_descriptor_proto as Buffer[]) {
              try {
                const bytes = new Uint8Array(buf);
                const fdp = FileDescriptorProto.deserializeBinary(bytes);
                const name = fdp.getName();
                if (name && !seen.has(name)) {
                  seen.add(name);
                  out.push(bytes);
                }
              } catch {
                // ignore bad descriptors
              }
            }
          }
        });
        call.on('error', (err: any) => reject(err));
        call.on('end', () => resolve(out));

        for (const sym of symbols) {
          call.write({ host: '', file_containing_symbol: sym });
        }
        call.end();

        // safety timeout
        setTimeout(() => {
          try { call.cancel(); } catch {}
          resolve(out);
        }, 7000);
      } catch (e) {
        reject(e);
      }
    });
  }

  private buildDescriptorSetObject(fdpBytes: Uint8Array[]): any {
    const files: any[] = [];
    for (const bytes of fdpBytes) {
      try {
        const decoded = pbDescriptor.FileDescriptorProto.decode(bytes);
        const obj = pbDescriptor.FileDescriptorProto.toObject(decoded, {
          defaults: true,
          arrays: true,
          objects: true,
          longs: String,
          enums: Number
        });
        this.normalizeDescriptorEnums(obj);
        files.push(obj);
        continue;
      } catch (err: any) {
      }
      try {
        const fdp = FileDescriptorProto.deserializeBinary(bytes);
        const obj = this.normalizeDescriptorJson(fdp.toObject(true));
        this.normalizeDescriptorEnums(obj);
        files.push(obj);
      } catch (err: any) {
      }
    }
    return { file: files };
  }

  // --- PGV extraction ---
  async getPgvRuleIndex(address: string, fullyQualifiedTypeNames: string[], metadata?: grpc.Metadata): Promise<Record<string, Record<string, any>>> {
    const key = `${address}`;
    const cached = this.pgvCache.get(key);
    if (cached) return cached;

    const fdpBytes = await this.fetchFileDescriptors(address, Array.from(new Set(fullyQualifiedTypeNames.filter(Boolean))), metadata);
    const index: Record<string, Record<string, any>> = {};
    let totalAdded = 0;
    for (const bytes of fdpBytes) {
      try {
        const fdp = FileDescriptorProto.deserializeBinary(bytes);
        const pkg = fdp.getPackage();
        const msgList = fdp.getMessageTypeList();
        for (const m of msgList) {
          totalAdded += this.extractPgvFromMessage(pkg || '', m, index, []);
        }
      } catch {
        // ignore
      }
    }
    if (totalAdded === 0) {
      // Fallback: parse directly from raw descriptor bytes to preserve unknown extensions
      for (const bytes of fdpBytes) {
        try {
          this.extractPgvFromRawFile(bytes, index);
        } catch {
          // ignore
        }
      }
    }
    this.pgvCache.set(key, index);
    return index;
  }

  private extractPgvFromMessage(pkg: string, msg: GDescriptorProto, index: Record<string, Record<string, any>>, parents: string[]): number {
    const parts = [...parents, msg.getName() || ''];
    const fqtn = (pkg ? `${pkg}.` : '') + parts.filter(Boolean).join('.');

    const fields = msg.getFieldList();
    let added = 0;
    for (const f of fields) {
      const rules = this.readPgvRulesFromFieldOptions(f);
      if (rules) {
        if (!index[fqtn]) index[fqtn] = {};
        const name = f.getJsonName() || f.getName() || '';
        index[fqtn][name] = rules;
        added++;
      }
    }

    const nested = msg.getNestedTypeList();
    for (const n of nested) {
      added += this.extractPgvFromMessage(pkg, n, index, parts);
    }
    return added;
  }

  private readPgvRulesFromFieldOptions(field: GFieldDescriptorProto): any | null {
    const opts = field.getOptions();
    if (!opts) return null;
    try {
      const buf = opts.serializeBinary();
      return this.readPgvFromOptionsBytes(buf);
    } catch {
      return null;
    }
  }

  private findExtension(buf: Uint8Array, fieldNo: number): Uint8Array | null {
    let off = 0;
    while (off < buf.length) {
      const [tag, o1] = this.readVarint(buf, off); off = o1;
      const fn = tag >>> 3; const wt = tag & 7;
      if (fn === fieldNo && wt === 2) {
        const [len, o2] = this.readVarint(buf, off); off = o2;
        const end = off + len;
        return buf.subarray(off, end);
      }
      off = this.skipField(buf, off, wt);
    }
    return null;
  }

  private readVarint(buf: Uint8Array, off: number): [number, number] {
    let x = 0; let s = 0; let o = off;
    while (o < buf.length) {
      const b = buf[o++];
      x |= (b & 0x7f) << s; s += 7;
      if ((b & 0x80) === 0) break;
    }
    return [x >>> 0, o];
  }

  // Raw parse to preserve unknown FieldOptions extensions
  private extractPgvFromRawFile(buf: Uint8Array, index: Record<string, Record<string, any>>): void {
    let off = 0;
    let pkg = '';
    const messageBodies: Uint8Array[] = [];
    while (off < buf.length) {
      const [tag, o1] = this.readVarint(buf, off); off = o1;
      const fn = tag >>> 3; const wt = tag & 7;
      if (fn === 2 && wt === 2) { // package
        const [len, o2] = this.readVarint(buf, off); off = o2;
        const end = off + len;
        pkg = new TextDecoder().decode(buf.subarray(off, end));
        off = end;
        continue;
      }
      if (fn === 4 && wt === 2) { // message_type
        const [len, o2] = this.readVarint(buf, off); off = o2;
        const end = off + len;
        messageBodies.push(buf.subarray(off, end));
        off = end;
        continue;
      }
      off = this.skipField(buf, off, wt);
    }
    for (const body of messageBodies) {
      this.extractPgvFromRawMessage(pkg, body, index, []);
    }
  }

  private extractPgvFromRawMessage(pkg: string, body: Uint8Array, index: Record<string, Record<string, any>>, parents: string[]): void {
    let off = 0;
    let name = '';
    const fields: Uint8Array[] = [];
    const nestedMsgs: Uint8Array[] = [];
    while (off < body.length) {
      const [tag, o1] = this.readVarint(body, off); off = o1;
      const fn = tag >>> 3; const wt = tag & 7;
      if (fn === 1 && wt === 2) { // name
        const [len, o2] = this.readVarint(body, off); off = o2;
        const end = off + len;
        name = new TextDecoder().decode(body.subarray(off, end));
        off = end;
        continue;
      }
      if (fn === 2 && wt === 2) { // field
        const [len, o2] = this.readVarint(body, off); off = o2;
        const end = off + len;
        fields.push(body.subarray(off, end));
        off = end;
        continue;
      }
      if (fn === 3 && wt === 2) { // nested_type
        const [len, o2] = this.readVarint(body, off); off = o2;
        const end = off + len;
        nestedMsgs.push(body.subarray(off, end));
        off = end;
        continue;
      }
      off = this.skipField(body, off, wt);
    }
    const fqtn = (pkg ? `${pkg}.` : '') + [...parents, name].filter(Boolean).join('.');
    for (const f of fields) this.extractPgvFromRawField(fqtn, f, index);
    for (const n of nestedMsgs) this.extractPgvFromRawMessage(pkg, n, index, [...parents, name]);
  }

  private extractPgvFromRawField(fqtn: string, body: Uint8Array, index: Record<string, Record<string, any>>): void {
    let off = 0;
    let name = '';
    let jsonName = '';
    let optionsBytes: Uint8Array | null = null;
    while (off < body.length) {
      const [tag, o1] = this.readVarint(body, off); off = o1;
      const fn = tag >>> 3; const wt = tag & 7;
      if (fn === 1 && wt === 2) { // name
        const [len, o2] = this.readVarint(body, off); off = o2;
        const end = off + len;
        name = new TextDecoder().decode(body.subarray(off, end));
        off = end;
        continue;
      }
      if (fn === 10 && wt === 2) { // json_name
        const [len, o2] = this.readVarint(body, off); off = o2;
        const end = off + len;
        jsonName = new TextDecoder().decode(body.subarray(off, end));
        off = end;
        continue;
      }
      if (fn === 8 && wt === 2) { // options
        const [len, o2] = this.readVarint(body, off); off = o2;
        const end = off + len;
        optionsBytes = body.subarray(off, end);
        off = end;
        continue;
      }
      off = this.skipField(body, off, wt);
    }
    if (optionsBytes) {
      const rulesObj = this.readPgvFromOptionsBytes(optionsBytes);
      if (rulesObj) {
        if (!index[fqtn]) index[fqtn] = {};
        const key = jsonName || name;
        index[fqtn][key] = rulesObj;
      }
    }
  }

  private skipField(buf: Uint8Array, off: number, wt: number): number {
    switch (wt) {
      case 0: { const [, o] = this.readVarint(buf, off); return o; }
      case 1: return off + 8;
      case 2: { const [l, o] = this.readVarint(buf, off); return o + l; }
      case 5: return off + 4;
      default: return off;
    }
  }

  private readPgvFromOptionsBytes(buf: Uint8Array): any | null {
    // First, try resolved extension field 1071
    const ext = this.findExtension(buf, 1071);
    if (ext) {
      try {
        const decoded = fromBinary(FieldRulesSchema, ext);
        const obj: any = { ...decoded } as any;
        if (obj?.type?.case === 'string' && obj.type?.value) {
          const v = obj.type.value;
          if (typeof v.minLen === 'bigint') v.minLen = Number(v.minLen);
          if (typeof v.maxLen === 'bigint') v.maxLen = Number(v.maxLen);
          if (typeof v.len === 'bigint') v.len = Number(v.len);
        }
        return obj;
      } catch {
        // fall through
      }
    }
    // Fallback: parse uninterpreted_option (field 999)
    const candidates = this.readUninterpretedOptions(buf);
    for (const u of candidates) {
      const path = u.path; // array of name parts, with parentheses preserved for extensions
      if (path.length >= 2 && path[0] === '(validate.rules)') {
        const rules: any = {};
        if (path[1] === 'message') {
          const txt = u.aggregate || '';
          if (/required\s*:\s*true/i.test(txt)) {
            rules.message = { required: true };
          }
        } else if (path[1] === 'string') {
          const txt = u.aggregate || '';
          const sr: any = {};
          const m = txt.match(/min_len\s*:\s*(\d+)/i);
          if (m) sr.minLen = Number(m[1]);
          const inMatch = txt.match(/in\s*:\s*\[(.*?)\]/i);
          if (inMatch) {
            const items = inMatch[1]
              .split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/)
              .map(s => s.trim())
              .map(s => s.replace(/^\"|\"$/g, ''))
              .filter(Boolean);
            if (items.length > 0) sr.in = items;
          }
          rules.type = { case: 'string', value: sr };
        }
        if (rules.message || rules.type) return rules;
      }
    }
    return null;
  }

  private readUninterpretedOptions(optionsBytes: Uint8Array): Array<{ path: string[]; aggregate?: string }> {
    const out: Array<{ path: string[]; aggregate?: string }> = [];
    let off = 0;
    while (off < optionsBytes.length) {
      const [tag, o1] = this.readVarint(optionsBytes, off); off = o1;
      const fn = tag >>> 3; const wt = tag & 7;
      if (fn === 999 && wt === 2) {
        const [len, o2] = this.readVarint(optionsBytes, off); off = o2;
        const end = off + len;
        const u = this.decodeUninterpretedOption(optionsBytes.subarray(off, end));
        out.push(u);
        off = end;
        continue;
      }
      off = this.skipField(optionsBytes, off, wt);
    }
    return out;
  }

  private decodeUninterpretedOption(buf: Uint8Array): { path: string[]; aggregate?: string } {
    let off = 0;
    const path: string[] = [];
    let aggregate: string | undefined;
    while (off < buf.length) {
      const [tag, o1] = this.readVarint(buf, off); off = o1;
      const fn = tag >>> 3; const wt = tag & 7;
      if (fn === 2 && wt === 2) { // name
        const [len, o2] = this.readVarint(buf, off); off = o2;
        const end = off + len;
        const namePart = this.decodeNamePart(buf.subarray(off, end));
        path.push(namePart);
        off = end;
        continue;
      }
      if (fn === 8 && wt === 2) { // aggregate_value
        const [len, o2] = this.readVarint(buf, off); off = o2;
        const end = off + len;
        aggregate = new TextDecoder().decode(buf.subarray(off, end));
        off = end;
        continue;
      }
      off = this.skipField(buf, off, wt);
    }
    return { path, aggregate };
  }

  private decodeNamePart(buf: Uint8Array): string {
    let off = 0;
    let name = '';
    let isExt = false;
    while (off < buf.length) {
      const [tag, o1] = this.readVarint(buf, off); off = o1;
      const fn = tag >>> 3; const wt = tag & 7;
      if (fn === 1 && wt === 2) { // name_part
        const [len, o2] = this.readVarint(buf, off); off = o2;
        const end = off + len;
        name = new TextDecoder().decode(buf.subarray(off, end));
        off = end;
        continue;
      }
      if (fn === 2 && wt === 0) { // is_extension
        const [val, o2] = this.readVarint(buf, off); off = o2;
        isExt = (val & 1) === 1;
        continue;
      }
      off = this.skipField(buf, off, wt);
    }
    return isExt ? `(${name})` : name;
  }

  private normalizeDescriptorJson(obj: any): any {
    if (obj == null || typeof obj !== 'object') return obj;

    // Rename *List -> * recursively
    const out: any = Array.isArray(obj) ? [] : {};
    const entries = Object.entries(obj);
    for (const [k, v] of entries) {
      const value = this.normalizeDescriptorJson(v);
      if (Array.isArray(value) && k.endsWith('List')) {
        out[k.slice(0, -4)] = value;
      } else if (k === 'oneofDeclList') {
        out['oneofDecl'] = value;
      } else if (k === 'jsonName') {
        out[k] = value;
      } else {
        out[k] = value;
      }
    }
    return out;
  }

  private normalizeDescriptorEnums(fileObj: any): void {
    if (!fileObj) return;
    const typeEnum = pbDescriptor.FieldDescriptorProto?.Type ?? {};
    const labelEnum = pbDescriptor.FieldDescriptorProto?.Label ?? {};
    const fallbackTypeEnum: Record<string, number> = {
      TYPE_DOUBLE: 1,
      TYPE_FLOAT: 2,
      TYPE_INT64: 3,
      TYPE_UINT64: 4,
      TYPE_INT32: 5,
      TYPE_FIXED64: 6,
      TYPE_FIXED32: 7,
      TYPE_BOOL: 8,
      TYPE_STRING: 9,
      TYPE_GROUP: 10,
      TYPE_MESSAGE: 11,
      TYPE_BYTES: 12,
      TYPE_UINT32: 13,
      TYPE_ENUM: 14,
      TYPE_SFIXED32: 15,
      TYPE_SFIXED64: 16,
      TYPE_SINT32: 17,
      TYPE_SINT64: 18,
    };
    const fallbackLabelEnum: Record<string, number> = {
      LABEL_OPTIONAL: 1,
      LABEL_REQUIRED: 2,
      LABEL_REPEATED: 3,
    };

    const fixMessage = (msg: any): void => {
      if (!msg) return;
      if (!Array.isArray(msg.oneofDecl) || msg.oneofDecl.length === 0) {
        if (Array.isArray(msg.field)) {
          for (const field of msg.field) {
            if (field && typeof field.oneofIndex === 'number') {
              delete field.oneofIndex;
            }
          }
        }
      }
      if (Array.isArray(msg.field)) {
        for (const field of msg.field) {
          if (typeof field.type === 'string') {
            field.type = typeEnum[field.type] ?? fallbackTypeEnum[field.type] ?? field.type;
          }
          if (typeof field.label === 'string') {
            field.label = labelEnum[field.label] ?? fallbackLabelEnum[field.label] ?? field.label;
          }
        }
      }
      if (Array.isArray(msg.nestedType)) {
        for (const nested of msg.nestedType) {
          fixMessage(nested);
        }
      }
    };

    if (Array.isArray(fileObj.messageType)) {
      for (const msg of fileObj.messageType) {
        fixMessage(msg);
      }
    }
  }

  private createReflectionPackageDefinition(): any {
    const path = require('path');
    const fs = require('fs');
    // Try multiple candidate locations relative to compiled dist dir
    const candidates = [
      path.join(__dirname, '../../../proto/grpc/reflection/v1alpha/reflection.proto'), // when running from dist
      path.join(process.cwd(), 'proto/grpc/reflection/v1alpha/reflection.proto')        // when run from project root
    ];
    const protoPath = candidates.find((p: string) => fs.existsSync(p));
    if (!protoPath) {
      throw new Error('reflection.proto not found in expected locations');
    }
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    return grpc.loadPackageDefinition(packageDefinition);
  }
}

// Runtime encoder/decoder using protobufjs Root
export class DynamicProtoCodec {
  constructor(private readonly root: pb.Root) {}

  encodeToAny(fqtn: string, jsonValue: any): { typeUrl: string; value: Uint8Array } {
    const Type = this.lookupType(fqtn);
    const err = Type.verify(jsonValue);
    if (err) throw new Error(`Invalid ${fqtn}: ${err}`);
    const msg = Type.fromObject(jsonValue);
    const bytes = Type.encode(msg).finish();
    return { typeUrl: `type.googleapis.com/${fqtn}`, value: bytes };
  }

  decodeAny(anyMsg: { typeUrl?: string; type_url?: string; value: Uint8Array | Buffer }): any {
    const typeUrl = (anyMsg.typeUrl || (anyMsg as any).type_url) as string;
    if (!typeUrl) throw new Error('Any missing typeUrl');
    const fqtn = typeUrl.replace(/^type\.googleapis\.com\//, '');
    const Type = this.lookupType(fqtn);
    const bytes = anyMsg.value instanceof Uint8Array ? anyMsg.value : new Uint8Array(anyMsg.value as Buffer);
    const msg = Type.decode(bytes);
    return Type.toObject(msg, { defaults: true });
  }

  lookupType(fqtn: string): pb.Type {
    const t = this.root.lookupTypeOrEnum(fqtn);
    if (!t || !(t as any).fields) {
      throw new Error(`Type not found in root: ${fqtn}`);
    }
    return t as pb.Type;
  }

  createMessage(fqtn: string, jsonValue: any): pb.Message<{}> {
    const Type = this.lookupType(fqtn);
    if (jsonValue == null || Object.keys(jsonValue).length === 0) {
      return Type.create();
    }
    const err = Type.verify(jsonValue);
    if (err) {
      throw new Error(`Invalid ${fqtn}: ${err}`);
    }
    return Type.fromObject(jsonValue);
  }
}
