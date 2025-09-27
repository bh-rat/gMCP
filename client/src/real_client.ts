import { createGrpcTransport } from "@connectrpc/connect-node";
import { createClient, Interceptor } from "@connectrpc/connect";
import { McpService } from "./generated/mcp/v0/mcp_pb";
import { ListToolsRequestSchema, Tool } from "./generated/mcp/v0/mcp_pb";
import { create as createMessage } from "@bufbuild/protobuf";
import * as grpc from "@grpc/grpc-js";
import { Buffer } from "buffer";
import { DescriptorCache } from "./reflection";
import "./generated/buf/validate/validate_pb";

interface ToolMetadata {
    name: string;
    title: string;
    description: string;
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

        // Derive input/output types from grpc_service and grpc_method
        const { inputType, outputType } = await this.deriveTypesFromService(tool.grpcService, tool.grpcMethod);
        const inputFqtn = this.normalizeTypeName(tool, inputType);
        const outputFqtn = this.normalizeTypeName(tool, outputType);
        if (!inputFqtn || !outputFqtn) {
            throw new Error(`Tool ${toolName} could not derive input/output types from service ${tool.grpcService}.${tool.grpcMethod}`);
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

        // Derive input type from grpc_service and grpc_method
        const { inputType } = await this.deriveTypesFromService(tool.grpcService, tool.grpcMethod);
        const inputFqtn = this.normalizeTypeName(tool, inputType);
        if (!inputFqtn) {
            return [`Tool '${toolName}' could not derive input type from service ${tool.grpcService}.${tool.grpcMethod}`];
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

            const { registry, validator } = await this.descriptors.getProtovalidateRuntime(
                this.address,
                [inputFqtn],
                metadata
            );
            const messageDesc = registry.getMessage(inputFqtn);
            if (!messageDesc) {
                return [`Unable to locate descriptor for type '${inputFqtn}' via reflection.`];
            }

            let protoMessage;
            try {
                protoMessage = createMessage(messageDesc, candidate);
            } catch (err: any) {
                return [`Failed to initialise message '${inputFqtn}': ${err?.message ?? String(err)}`];
            }

            const validationResult = validator.validate(messageDesc, protoMessage);
            console.debug?.('[RealMcpClient.validateInputs] validation result', validationResult);
            if (validationResult.kind === 'invalid') {
                return validationResult.violations.map((v) => v.toString());
            }
            if (validationResult.kind === 'error') {
                return [`Validation failed: ${validationResult.error.message}`];
            }

            // Attempt to materialize the request message to surface nested errors via protobuf.js.
            const materialized = requestType.fromObject(candidate);
            return [];
        } catch (err: any) {
            return [err?.message ?? String(err)];
        }
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

    async deriveTypesFromService(grpcService: string, grpcMethod: string): Promise<{ inputType: string; outputType: string }> {
        // First verify the service exists using basic reflection
        const metadata = this.buildGrpcMetadata();
        const descriptorInfo = await this.descriptors.getDescriptors(this.address, metadata);
        
        // Check if the service exists in the descriptor info
        if (!descriptorInfo.meta.services.includes(grpcService)) {
            throw new Error(`Service ${grpcService} not found in reflection data. Available services: ${descriptorInfo.meta.services.join(', ')}`);
        }

        // Skip method validation since the reflection parsing is incomplete
        // Instead, try to fetch the service descriptors directly and see if we can find the method

        // Fetch all service descriptors to get the method information
        const allServices = descriptorInfo.meta.services.filter(s => !s.includes('grpc.reflection'));
        const root = await this.descriptors.getTypesRoot(this.address, allServices, metadata);

        // Try to find the service in the root
        const service = root.lookupService(grpcService);
        if (!service) {
            console.log('🔍 Root nested structure:', root.nested);
            throw new Error(`Service ${grpcService} not found in parsed descriptors. Available in root: ${Object.keys(root.nested || {}).join(', ')}`);
        }

        const method = service.methods[grpcMethod];
        if (!method) {
            throw new Error(`Method ${grpcMethod} not found in service descriptors. Available methods: ${Object.keys(service.methods || {}).join(', ')}`);
        }

        // Return the fully qualified type names, removing leading dots
        const inputType = method.requestType.startsWith('.') ? method.requestType.substring(1) : method.requestType;
        const outputType = method.responseType.startsWith('.') ? method.responseType.substring(1) : method.responseType;

        return {
            inputType,
            outputType
        };
    }

    private normalizeGrpcError(error: grpc.ServiceError): { code: string; message: string } {
        return {
            code: error.code != null ? grpc.status[error.code] ?? 'UNKNOWN' : 'UNKNOWN',
            message: error.message || 'gRPC request failed'
        };
    }

    async getSchemaFromMessageType(inputType: string, grpcService: string): Promise<any> {
        try {
            const metadata = this.buildGrpcMetadata();
            const inputFqtn = inputType.includes('.') ? inputType : this.normalizeTypeName({ grpcService } as ToolMetadata, inputType);
            const root = await this.descriptors.getTypesRoot(this.address, [inputFqtn], metadata);
            const codec = this.descriptors.buildCodec(root);
            const requestType = codec.lookupType(inputFqtn);

            // Convert protobuf message structure to JSON schema
            const schema = this.convertProtobufToJsonSchema(requestType);
            return schema;
        } catch (error: any) {
            console.error(`Failed to get schema for message type ${inputType}:`, error);
            throw error;
        }
    }

    private convertProtobufToJsonSchema(messageType: any): any {
        const properties: Record<string, any> = {};
        const required: string[] = [];

        // Iterate through the message fields
        for (const field of messageType.fieldsArray || []) {
            const fieldName = field.name;
            const fieldType = this.getJsonSchemaType(field);

            properties[fieldName] = fieldType;

            // Check if field is required (proto3 doesn't have required, but we can infer from validation rules)
            if (this.isFieldRequired(field)) {
                required.push(fieldName);
            }
        }

        return {
            type: 'object',
            properties,
            required,
            description: `Schema for ${messageType.fullName}`
        };
    }

    private getJsonSchemaType(field: any): any {
        const baseType = this.getBaseJsonType(field.type);
        let schemaType: any = { type: baseType };

        // Add validation constraints from field options if available
        if (field.options) {
            this.addValidationConstraints(schemaType, field.options);
        }

        // Add description if available
        if (field.comment) {
            schemaType.description = field.comment;
        }

        return schemaType;
    }

    private getBaseJsonType(protoType: string): string {
        switch (protoType) {
            case 'string':
                return 'string';
            case 'int32':
            case 'int64':
            case 'uint32':
            case 'uint64':
            case 'sint32':
            case 'sint64':
            case 'fixed32':
            case 'fixed64':
            case 'sfixed32':
            case 'sfixed64':
                return 'integer';
            case 'double':
            case 'float':
                return 'number';
            case 'bool':
                return 'boolean';
            case 'bytes':
                return 'string'; // Base64 encoded
            default:
                return 'object'; // For nested messages
        }
    }

    private addValidationConstraints(schemaType: any, options: any): void {
        // This is where we would parse buf.validate constraints
        // For now, we'll add some basic constraints based on the weather example
        if (schemaType.type === 'string') {
            // Look for string validation rules
            if (options?.['(buf.validate.field)']?.string) {
                const stringConstraints = options['(buf.validate.field)'].string;
                if (stringConstraints.min_len !== undefined) {
                    schemaType.minLength = stringConstraints.min_len;
                }
                if (stringConstraints.max_len !== undefined) {
                    schemaType.maxLength = stringConstraints.max_len;
                }
                if (stringConstraints.in && Array.isArray(stringConstraints.in)) {
                    schemaType.enum = stringConstraints.in;
                }
            }
        }
    }

    private isFieldRequired(field: any): boolean {
        // In proto3, fields are optional by default
        // We could check for validation rules that make a field effectively required
        if (field.options?.['(buf.validate.field)']?.string?.min_len > 0) {
            return true;
        }
        return false;
    }
}
