export class ProtoCodec {
  constructor() {}

  packToAny(typeName: string, data: any): any {
    // For gRPC client, we create the Any structure directly
    return {
      type_url: `type.googleapis.com/${typeName}`,
      value: Buffer.from(JSON.stringify(data))
    };
  }

  unpackFromAny<T = any>(any: any, expectedTypeName: string): T {
    const typeUrl = any.type_url || any.typeUrl;
    if (!typeUrl.endsWith(`/${expectedTypeName}`)) {
      throw new Error(`Type URL mismatch: expected ${expectedTypeName}, got ${typeUrl}`);
    }

    try {
      // For simple cases, parse as JSON from the value buffer
      if (any.value && Buffer.isBuffer(any.value)) {
        return JSON.parse(any.value.toString()) as T;
      } else if (typeof any.value === 'string') {
        return JSON.parse(any.value) as T;
      } else {
        return any.value as T;
      }
    } catch (error) {
      throw new Error(`Failed to unpack Any to message: ${error}`);
    }
  }

  validateTypeUrl(typeUrl: string, expectedTypeName: string): boolean {
    return typeUrl.endsWith(`/${expectedTypeName}`);
  }
}