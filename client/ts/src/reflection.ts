import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as pb from 'protobufjs';
import { FileDescriptorProto } from 'google-protobuf/google/protobuf/descriptor_pb';
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
      console.log('🔍 Using gRPC reflection to discover server services...');

      try {
        const services = await this.listServicesUsingReflection(address, metadata);
        const serverMeta = await this.getServerMetaUsingReflection(address, metadata, services);

        cached = {
          meta: serverMeta,
          available: true,
          reflectionData: { services }
        };

        console.log('✅ Server reflection data discovered:');
        console.log(`  Services: ${serverMeta.services.join(', ')}`);
        console.log(`  Methods: ${Object.keys(serverMeta.methods).length} service(s)`);

      } catch (error: any) {
        console.log('⚠️  Reflection failed, using fallback metadata:', error.message);
        cached = {
          meta: {
            serverId: 'unknown-fallback',
            serverVersion: '1.0.0',
            services: ['mcp.v0.McpService'],
            methods: { 'mcp.v0.McpService': ['ListTools', 'CallTool'] }
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
      console.log('📡 Creating reflection client...');

      try {
        const reflectionProto = this.createReflectionPackageDefinition() as any;
        const client = new reflectionProto.grpc.reflection.v1alpha.ServerReflection(
          address,
          grpc.credentials.createInsecure()
        );

        console.log('📡 Making reflection call...');

        const call = client.ServerReflectionInfo(metadata || new grpc.Metadata());

        call.on('data', (response: any) => {
          console.log('📦 Received reflection response:', response);

          if (response.list_services_response) {
            const services = response.list_services_response.service.map((svc: any) => svc.name);
            console.log('✅ Discovered services via reflection:', services);
            call.end();
            resolve(services);
          }
        });

        call.on('error', (error: any) => {
          console.log('❌ Reflection call error:', error.message);
          call.end();
          reject(error);
        });

        call.on('end', () => {
          console.log('🏁 Reflection call ended');
        });

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
        console.log('❌ Failed to create reflection client:', error.message);
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
        methods[service] = ['ListTools', 'CallTool'];
      } else if (service === 'grpc.reflection.v1alpha.ServerReflection') {
        methods[service] = ['ServerReflectionInfo'];
      }
    }

    return methods;
  }

  clearCache(): void {
    this.cache.clear();
    console.log('🗑️  Reflection cache cleared');
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
        const fdp = FileDescriptorProto.deserializeBinary(bytes);
        const obj = fdp.toObject();
        files.push(this.normalizeDescriptorJson(obj));
      } catch {
        // skip
      }
    }
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
}