/**
 * A self-contained `defineTool` for profile-installed bundles.
 *
 * The Harness ships its own `defineTool` in `@deepseek-ai/dsh-tools`, but a
 * bundle installed into a profile is imported by plain Node ESM resolution from
 * its own directory, which cannot see the packages inside the application
 * archive. This module therefore reimplements the small part of that API this
 * bundle uses — the parameter/value schema DSL and argument validation — so the
 * plugin depends on nothing outside itself.
 *
 * The output is an ordinary registry-ready `ToolDefinition`: `parameters` and
 * `output.schema` are raw JSON Schema restricted to the subset the registry
 * asserts (type, properties, required, additionalProperties, items, enum,
 * oneOf, const plus annotations).
 * @module dsh-research-paper-mode/lib/tool-schema
 */

const SCHEMA_KEYS = new Set([
  'type',
  'description',
  'required',
  'items',
  'properties',
  'additionalProperties',
  'enum',
  'title',
  'default',
]);

function assertSpecObject(spec, path) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path}: schema spec must be an object`);
  }
  for (const key of Object.keys(spec)) {
    if (!SCHEMA_KEYS.has(key)) {
      throw new Error(`${path}: unsupported schema keyword "${key}" (allowed: ${[...SCHEMA_KEYS].join(', ')})`);
    }
  }
}

/** Convert one value-schema spec into raw JSON Schema. */
export function toJsonSchema(spec, path = 'schema') {
  assertSpecObject(spec, path);
  const { type } = spec;
  if (typeof type !== 'string') throw new Error(`${path}: missing "type"`);

  if (type === 'array') {
    if (spec.items === undefined) throw new Error(`${path}: an array schema requires "items"`);
    return { type: 'array', items: toJsonSchema(spec.items, `${path}.items`) };
  }

  if (type === 'object') {
    const node = { type: 'object' };
    if (spec.properties !== undefined) {
      const properties = {};
      const required = [];
      for (const [key, child] of Object.entries(spec.properties)) {
        const childPath = `${path}.properties.${key}`;
        assertSpecObject(child, childPath);
        properties[key] = toJsonSchema(child, childPath);
        if (child.required === true) required.push(key);
      }
      node.properties = properties;
      if (required.length > 0) node.required = required;
    }
    if (spec.additionalProperties !== undefined) node.additionalProperties = spec.additionalProperties;
    return node;
  }

  const node = { type };
  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) throw new Error(`${path}.enum must be a non-empty array`);
    node.enum = [...spec.enum];
  }
  return node;
}

/** Convert an implicit-open parameter map into an object-rooted schema. */
export function toParameterSchema(spec, path = 'parameters') {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path}: parameter spec must be an object`);
  }
  const properties = {};
  const required = [];
  for (const [key, child] of Object.entries(spec)) {
    const childPath = `${path}.${key}`;
    assertSpecObject(child, childPath);
    properties[key] = toJsonSchema(child, childPath);
    if (child.required === true) required.push(key);
  }
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) };
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a value against the supported schema subset.
 * @returns {string[]} path-qualified violations; empty means valid.
 */
export function validateJsonSchemaValue(value, schema, path = '') {
  const violations = [];
  const actual = typeName(value);
  if (schema.type === 'integer') {
    if (actual !== 'number' || !Number.isInteger(value)) violations.push(`${path}: expected integer, received ${actual}`);
  } else if (schema.type !== undefined && schema.type !== actual) {
    violations.push(`${path}: expected ${schema.type}, received ${actual}`);
    return violations;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'object' && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`${path}.${key}: unexpected property`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) violations.push(...validateJsonSchemaValue(value[key], child, `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && actual === 'array' && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      violations.push(...validateJsonSchemaValue(item, schema.items, `${path}[${index}]`));
    }
  }
  return violations;
}

/**
 * Build a registry-ready tool definition, validating arguments on the way in
 * and the returned value on the way out.
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, object>,
 *   output: { schema: object, render: (args: object, value: object) => object[] },
 *   execute: (args: object, exec: object) => Promise<object>,
 * }} options
 */
export function defineTool(options) {
  const { name } = options;
  if (typeof name !== 'string' || name.length === 0) throw new Error('defineTool: a non-empty name is required');
  if (typeof options.description !== 'string' || options.description.length === 0) {
    throw new Error(`defineTool(${name}): a description is required`);
  }
  if (!isPlainObject(options.output) || typeof options.output.render !== 'function') {
    throw new Error(`defineTool(${name}): output.render is required`);
  }

  const parameters = toParameterSchema(options.parameters, `${name}.parameters`);
  const outputSchema = toJsonSchema(options.output.schema, `${name}.output.schema`);

  return {
    name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render: options.output.render },
    async execute(args, exec) {
      const violations = validateJsonSchemaValue(args, parameters, `${name} arguments`);
      if (violations.length > 0) throw new Error(`${name}: invalid arguments: ${violations.join('; ')}`);
      const value = await options.execute(args, exec);
      const outputViolations = validateJsonSchemaValue(value, outputSchema, `${name} output`);
      if (outputViolations.length > 0) throw new Error(`${name}: invalid output: ${outputViolations.join('; ')}`);
      return value;
    },
  };
}
