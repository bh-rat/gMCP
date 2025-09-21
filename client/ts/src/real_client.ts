import { createGrpcTransport } from "@connectrpc/connect-node";
import { createClient, Interceptor } from "@connectrpc/connect";
import { McpService } from "./generated/mcp/v0/mcp_pb.js";
import { ListToolsRequestSchema, Tool } from "./generated/mcp/v0/mcp_pb.js";
import { create as createMessage } from "@bufbuild/protobuf";
import * as grpc from "@grpc/grpc-js";
import { Buffer } from "buffer";
import { DescriptorCache } from "./reflection";
import "./generated/validate/validate_pb.js";

interface ToolMetadata {
    name: string;
    title: string;
    description: string;
    inputType: string;
    outputType: string;
    grpcService: string;
    grpcMethod: string;
    annotations: Record<string, string>;
}

export class RealMcpClient {
    private client: any;
    private transport: any;
    private descriptors = new DescriptorCache();

    constructor(private address: string, private options?: { metadata?: Record<string, string> }) {}

    async connect(): Promise<void> {
        const headerInterceptor: Interceptor | undefined = this.options?.metadata
            ? (next) => async (req) => {
                for (const [key, value] of Object.entries(this.options!.metadata!)) {
                    req.header.set(key, value);
                }
                return next(req);
            }
            : undefined;

        this.transport = createGrpcTransport({
            baseUrl: `http://${this.address}`,
            interceptors: headerInterceptor ? [headerInterceptor] : []
        });

        this.client = createClient(McpService as any, this.transport);
    }

    async listTools(cursor?: string, pageSize?: number): Promise<{ success: true; tools: ToolMetadata[] }> {
        const request = createMessage(ListToolsRequestSchema, {
            cursor: cursor ?? "",
            pageSize: pageSize ?? 100
        });

        const response = await this.client.listTools(request);
        return {
            success: true,
            tools: (response.tools as Tool[]).map((tool: Tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputType: tool.inputType,
                outputType: tool.outputType,
                grpcService: tool.grpcService,
                grpcMethod: tool.grpcMethod,
                annotations: tool.annotations
            }))
        };
    }

    async callTool(toolName: string, args: Record<string, any>): Promise<{ success: boolean; results: Array<{ seq: number; final: boolean; result?: any; error?: any }> }> {
        const { tools } = await this.listTools();
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
            throw new Error(`Tool ${toolName} not found`);
        }
        if (!tool.grpcService || !tool.grpcMethod) {
            throw new Error(`Tool ${toolName} does not advertise grpc_service/grpc_method metadata`);
        }

        const inputFqtn = this.normalizeTypeName(tool, tool.inputType);
        const outputFqtn = this.normalizeTypeName(tool, tool.outputType);
        if (!inputFqtn || !outputFqtn) {
            throw new Error(`Tool ${toolName} is missing input/output type metadata`);
        }

        const metadataForReflection = this.buildGrpcMetadata();
        const root = await this.descriptors.getTypesRoot(this.address, [inputFqtn, outputFqtn], metadataForReflection);
        const codec = this.descriptors.buildCodec(root);
        const requestType = codec.lookupType(inputFqtn);
        const responseType = codec.lookupType(outputFqtn);

        const requestMessage = codec.createMessage(inputFqtn, args ?? {});
        const metadata = new grpc.Metadata();
        this.populateGrpcMetadata(metadata);

        const client = new grpc.Client(this.address, grpc.credentials.createInsecure());

        const invokeUnary = (): Promise<any> => {
            return new Promise((resolve, reject) => {
                client.makeUnaryRequest(
                    `/${tool.grpcService}/${tool.grpcMethod}`,
                    (value: any) => Buffer.from(requestType.encode(value).finish()),
                    (buffer: Buffer) => responseType.decode(buffer),
                    requestMessage,
                    metadata,
                    (err: grpc.ServiceError | null, response: any) => {
                        client.close();
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve(response);
                    }
                );
            });
        };

        try {
            const responseMessage = await invokeUnary();
            const resultObject = responseType.toObject(responseMessage, { defaults: true });
            return {
                success: true,
                results: [{ seq: 0, final: true, result: resultObject }]
            };
        } catch (error: any) {
            return {
                success: false,
                results: [{ seq: 0, final: true, error: this.normalizeGrpcError(error) }]
            };
        }
    }

    async discover(): Promise<ToolMetadata[]> {
        const res = await this.listTools();
        return res.tools;
    }

    async *call(name: string, args: any): AsyncIterable<any> {
        const { results } = await this.callTool(name, args);
        for (const r of results) {
            yield r;
        }
    }

    getReflectionInfo(): any | null {
        return null;
    }

    close(): void {}

    async validateInputs(toolName: string, inputs: Record<string, any>): Promise<string[]> {
        const { tools } = await this.listTools();
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
            return [`Tool '${toolName}' is not advertised by the server.`];
        }

        const inputFqtn = this.normalizeTypeName(tool, tool.inputType);
        if (!inputFqtn) {
            return [`Tool '${toolName}' is missing input type metadata.`];
        }

        try {
            const metadata = this.buildGrpcMetadata();
            const root = await this.descriptors.getTypesRoot(this.address, [inputFqtn], metadata);
            const codec = this.descriptors.buildCodec(root);
            const requestType = codec.lookupType(inputFqtn);
            const candidate = inputs ?? {};
            const verifyError = requestType.verify(candidate);
            if (verifyError) {
                return [verifyError];
            }

            // Extract and enforce PGV rules via buf-generated extensions
            const pgvIndex = await this.descriptors.getPgvRuleIndex(this.address, [inputFqtn], metadata);
            const violations = this.applyPgvIndexRules(inputFqtn, requestType, candidate, pgvIndex);
            if (violations.length > 0) {
                return violations;
            }

            // Attempt to materialize the request message to surface nested errors.
            const materialized = requestType.fromObject(candidate);
            return [];
        } catch (err: any) {
            return [err?.message ?? String(err)];
        }
    }

    private applyPgvIndexRules(fqtn: string, type: any, candidate: Record<string, any>, index: Record<string, Record<string, any>>): string[] {
        const violations: string[] = [];
        const fieldMap = index[fqtn] ?? {};
        const fields: any[] = Array.isArray(type.fieldsArray) ? type.fieldsArray : [];
        for (const field of fields) {
            const name: string = field.name;
            const rules = fieldMap[name];
            if (!rules) continue;
            const value = candidate[name];

            // message.required
            const messageRules = rules.message;
            if (messageRules?.required && (value === undefined || value === null || value === '')) {
                violations.push(`field '${name}' is required`);
                continue;
            }

            // string rules
            if (rules.type?.case === 'string') {
                const sr = rules.type.value || {};
                const str = typeof value === 'string' ? value : '';
                if (sr.minLen !== undefined && str.length < Number(sr.minLen)) {
                    violations.push(`field '${name}' must be at least ${Number(sr.minLen)} characters`);
                    continue;
                }
                if (Array.isArray(sr.in) && sr.in.length > 0 && str && !sr.in.includes(str)) {
                    violations.push(`field '${name}' must be one of: ${sr.in.join(', ')}`);
                    continue;
                }
            }
        }
        return violations;
    }

    private applyPgvRules(type: any, candidate: Record<string, any>): string[] {
        const violations: string[] = [];
        const fields: any[] = Array.isArray(type.fieldsArray) ? type.fieldsArray : [];

        for (const field of fields) {
            const fieldName: string = field.name;
            const options: any = field.options ?? {};
            const rules = options['(.validate.rules)'];
            if (!rules || !rules.string) {
                continue;
            }

            const stringRules = rules.string as Record<string, unknown>;
            const rawValue = candidate[fieldName];
            const value = typeof rawValue === 'string' ? rawValue : '';

            if (stringRules.minLen !== undefined) {
                const minLen = Number(stringRules.minLen);
                if (!value || value.length < minLen) {
                    violations.push(`field '${fieldName}' must be at least ${minLen} characters`);
                    continue;
                }
            }

            if (Array.isArray(stringRules.in) && stringRules.in.length > 0) {
                if (!value || !stringRules.in.includes(value)) {
                    violations.push(`field '${fieldName}' must be one of: ${stringRules.in.join(', ')}`);
                    continue;
                }
            }
        }

        return violations;
    }

    private buildGrpcMetadata(): grpc.Metadata | undefined {
        if (!this.options?.metadata) {
            return undefined;
        }
        const metadata = new grpc.Metadata();
        for (const [key, value] of Object.entries(this.options.metadata)) {
            metadata.set(key, value);
        }
        return metadata;
    }

    private populateGrpcMetadata(metadata: grpc.Metadata): void {
        if (!this.options?.metadata) {
            return;
        }
        for (const [key, value] of Object.entries(this.options.metadata)) {
            metadata.set(key, value);
        }
    }

    private normalizeTypeName(tool: ToolMetadata, fqtn?: string): string {
        if (!fqtn || fqtn.includes(".")) {
            return fqtn ?? "";
        }
        const service = tool.grpcService ?? "";
        const parts = service.split(".");
        if (parts.length <= 1) {
            return fqtn;
        }
        parts.pop();
        const pkg = parts.join(".");
        return pkg ? `${pkg}.${fqtn}` : fqtn;
    }

    private normalizeGrpcError(error: grpc.ServiceError): { code: string; message: string } {
        return {
            code: error.code != null ? grpc.status[error.code] ?? 'UNKNOWN' : 'UNKNOWN',
            message: error.message || 'gRPC request failed'
        };
    }
}
