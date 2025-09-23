import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import 'protobufjs/ext/descriptor';
import * as pb from 'protobufjs';
import { FileDescriptorProto, DescriptorProto as GDescriptorProto, FieldDescriptorProto as GFieldDescriptorProto } from 'google-protobuf/google/protobuf/descriptor_pb';
import { create, createFileRegistry, fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema, FileDescriptorSetSchema, file_google_protobuf_descriptor, file_google_protobuf_duration, file_google_protobuf_timestamp } from '@bufbuild/protobuf/wkt';
import { file_buf_validate_validate } from './generated/buf/validate/validate_pb';
import { createValidator } from '@bufbuild/protovalidate';
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
  private validatorCache = new Map<string, {
    registry: ReturnType<typeof createFileRegistry>;
    validator: ReturnType<typeof createValidator>;
  }>();

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
    console.debug?.('[DescriptorCache:getTypesRoot] descriptorSetObj files:', (descriptorSetObj.file || []).map((f: any) => f?.name));

    // Build protobufjs Root using descriptor extension if available; fallback to empty Root
    const RootAny: any = pb.Root as any;
    console.debug?.('[DescriptorCache:getTypesRoot] Root.fromDescriptor typeof', typeof RootAny.fromDescriptor);
    let root: pb.Root;
    try {
      root = typeof RootAny.fromDescriptor === 'function'
        ? (RootAny.fromDescriptor(descriptorSetObj) as pb.Root)
        : new pb.Root();
      root.resolveAll();
    } catch (err) {
      console.error('[DescriptorCache:getTypesRoot] failed to build root', err, descriptorSetObj);
      throw err;
    }

    this.rootCache.set(key, root);
    return root;
  }

  buildCodec(root: pb.Root) {
    return new DynamicProtoCodec(root);
  }

  async getProtovalidateRuntime(
    address: string,
    fullyQualifiedTypeNames: string[],
    metadata?: grpc.Metadata
  ): Promise<{ registry: ReturnType<typeof createFileRegistry>; validator: ReturnType<typeof createValidator> }> {
    const key = `${address}`;
    const cached = this.validatorCache.get(key);
    if (cached) {
      return cached;
    }

    const descriptorBytes = await this.fetchFileDescriptors(
      address,
      Array.from(new Set(fullyQualifiedTypeNames.filter(Boolean))),
      metadata
    );

    const fileSet = create(FileDescriptorSetSchema, { file: [] });
    const seen = new Set<string>();
    for (const bytes of descriptorBytes) {
      const file = fromBinary(FileDescriptorProtoSchema, bytes);
      const name = file.name ?? '';
      if (name && seen.has(name)) {
        continue;
      }
      if (name) {
        seen.add(name);
      }
      fileSet.file.push(file);
    }

    const ensureFile = (proto: any) => {
      const name = proto?.name ?? '';
      if (!name || seen.has(name)) {
        return;
      }
      const cloned = create(FileDescriptorProtoSchema, proto);
      fileSet.file.unshift(cloned);
      seen.add(name);
    };

    ensureFile(file_buf_validate_validate.proto);
    ensureFile(file_google_protobuf_descriptor.proto);
    ensureFile(file_google_protobuf_duration.proto);
    ensureFile(file_google_protobuf_timestamp.proto);

    console.debug?.('[DescriptorCache:getProtovalidateRuntime] files in set:', fileSet.file.map((f) => f.name));

    // Build a resolver-based registry to avoid ordering issues in FileDescriptorSet
    // Map files by name for quick resolution
    const nameToFile = new Map<string, any>();
    for (const f of fileSet.file) {
      if (f?.name) nameToFile.set(f.name, f);
    }
    // Ensure common deps exist in the map (typed fallbacks)
    const ensureInMap = (f: any) => {
      const n = f?.name;
      if (n && !nameToFile.has(n)) nameToFile.set(n, f);
    };
    ensureInMap(file_buf_validate_validate.proto);
    ensureInMap(file_google_protobuf_descriptor.proto);
    ensureInMap(file_google_protobuf_duration.proto);
    ensureInMap(file_google_protobuf_timestamp.proto);

    // Pick an entry file that we know references validation rules
    const entryFile = nameToFile.get('weather/weather.proto')
      || nameToFile.get('mcp/v0/mcp.proto')
      || fileSet.file[0];

    const registry = createFileRegistry(entryFile, (fname: string) => nameToFile.get(fname));
    const validator = createValidator({ registry });

    const cacheEntry = { registry, validator };
    this.validatorCache.set(key, cacheEntry);
    return cacheEntry;
  }

  private async fetchFileDescriptors(address: string, symbols: string[], metadata?: grpc.Metadata): Promise<Uint8Array[]> {
    const reflectionProto = this.createReflectionPackageDefinition();

    type Req = { symbol?: string; filename?: string };

    const fetchBatch = (reqs: Req[]): Promise<Map<string, Uint8Array>> => {
      return new Promise((resolve, reject) => {
        try {
          const client = new (reflectionProto as any).grpc.reflection.v1alpha.ServerReflection(
            address,
            grpc.credentials.createInsecure()
          );
          const call = client.ServerReflectionInfo(metadata || new grpc.Metadata());

          const out = new Map<string, Uint8Array>();
          const seenNames = new Set<string>();

          call.on('data', (response: any) => {
            const fdr = response.file_descriptor_response;
            if (fdr?.file_descriptor_proto) {
              for (const buf of fdr.file_descriptor_proto as Buffer[]) {
                try {
                  const bytes = new Uint8Array(buf);
                  const fdp = FileDescriptorProto.deserializeBinary(bytes);
                  const name = fdp.getName();
                  if (name && !seenNames.has(name)) {
                    seenNames.add(name);
                    out.set(name, bytes);
                  }
                } catch {
                  // ignore bad descriptors
                }
              }
            }
          });
          call.on('error', (err: any) => reject(err));
          call.on('end', () => resolve(out));

          for (const r of reqs) {
            if (r.symbol) {
              call.write({ host: '', file_containing_symbol: r.symbol });
            } else if (r.filename) {
              call.write({ host: '', file_by_filename: r.filename });
            }
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
    };

    const getDeps = (bytes: Uint8Array): string[] => {
      try {
        const fdp = FileDescriptorProto.deserializeBinary(bytes);
        const deps = (fdp as any).getDependencyList?.() as string[] | undefined;
        return Array.isArray(deps) ? deps : [];
      } catch {
        return [];
      }
    };

    const all = new Map<string, Uint8Array>();

    // 1) Fetch files containing requested symbols
    const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)));
    if (uniqueSymbols.length > 0) {
      const symBatch = await fetchBatch(uniqueSymbols.map((s) => ({ symbol: s })));
      for (const [name, bytes] of symBatch) {
        all.set(name, bytes);
      }
    }

    // 2) Recursively fetch transitive dependencies by filename
    const pending = new Set<string>();
    for (const [, bytes] of all) {
      for (const dep of getDeps(bytes)) {
        if (!all.has(dep)) pending.add(dep);
      }
    }

    while (pending.size > 0) {
      const filenames = Array.from(pending);
      pending.clear();
      const depBatch = await fetchBatch(filenames.map((f) => ({ filename: f })));
      for (const [name, bytes] of depBatch) {
        if (!all.has(name)) {
          all.set(name, bytes);
          for (const dep of getDeps(bytes)) {
            if (!all.has(dep)) pending.add(dep);
          }
        }
      }
    }

    console.debug?.('[DescriptorCache:fetchFileDescriptors] fetched files:', Array.from(all.keys()));
    return Array.from(all.values());
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

    const ensureDescriptor = (proto: any) => {
      const name = proto?.name ?? '';
      if (!name) {
        return;
      }
      if (files.some((f: any) => f?.name === name)) {
        return;
      }
      const clone = typeof structuredClone === 'function'
        ? structuredClone(proto)
        : JSON.parse(JSON.stringify(proto, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)));
      this.normalizeDescriptorEnums(clone);
      files.push(clone);
    };

    ensureDescriptor(file_buf_validate_validate.proto);
    ensureDescriptor(file_google_protobuf_descriptor.proto);
    ensureDescriptor(file_google_protobuf_duration.proto);
    ensureDescriptor(file_google_protobuf_timestamp.proto);

    console.debug?.('[DescriptorCache:buildDescriptorSetObject] files:', files.map((f: any) => f?.name));

    return { file: files };
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
