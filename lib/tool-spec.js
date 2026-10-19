// The tool authoring surface this bundle needs, implemented locally.
//
// Why this file exists: the desktop profile cannot resolve `@deepseek-ai/dsh-tools`
// from a third-party bundle (only `cosmokit` / `schemastery` are materialised in the
// profile's `node_modules`), so importing `defineTool` from the host package would
// make the plugin fail to load. `tools.register()` does not re-validate
// `parameters`, so building the same shapes here is enough:
//
//   * `parameters` / `output.schema` are authored as a per-key map (the same shape
//     the host's `parameterSchemaSpecToJsonSchema` accepts),
//   * the compiled result is plain JSON Schema from the subset the host accepts
//     (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
//     `const`, `oneOf` plus the annotations `description`/`title`/`default`/`examples`),
//   * `execute` validates its arguments exactly like the host's `defineTool` does and
//     throws when a required argument is missing or a value has the wrong type.
//
// Keep the emitted schema free of keywords outside that subset: the host asserts it
// with `assertSupportedJsonSchema` and would refuse the whole registration.

const ANNOTATIONS = ['description', 'title', 'default', 'examples'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authorError(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

/**
 * Compile one author node into the JSON Schema subset the host accepts.
 *
 * A child written as `{ required: true }` is hoisted into the parent's `required`
 * array and stripped from the child — the same normalisation the host performs, so a
 * spec authored for `@deepseek-ai/dsh-tools` can be copied here unchanged.
 */
function compileNode(spec, path) {
  if (!isPlainObject(spec)) authorError(path, 'schema node must be an object');
  if (spec.type !== undefined && spec.oneOf !== undefined) {
    authorError(path, 'a schema node cannot declare both "type" and "oneOf"');
  }
  if (spec.required !== undefined && spec.required !== true && !Array.isArray(spec.required)) {
    authorError(`${path}.required`, 'must be true (per key) or an array of property names');
  }

  const out = {};
  if (spec.type !== undefined) out.type = String(spec.type);
  if (spec.const !== undefined) out.const = spec.const;
  if (Array.isArray(spec.enum)) out.enum = spec.enum.slice();
  if (Array.isArray(spec.oneOf)) out.oneOf = spec.oneOf.map((node, index) => compileNode(node, `${path}.oneOf[${index}]`));
  if (Array.isArray(spec.anyOf)) authorError(`${path}.anyOf`, 'not supported; use oneOf');

  const hoisted = [];
  if (spec.items !== undefined) out.items = compileNode(spec.items, `${path}.items`);

  if (isPlainObject(spec.properties)) {
    const properties = {};
    for (const [key, child] of Object.entries(spec.properties)) {
      properties[key] = compileNode(child, `${path}.properties.${key}`);
      if (isPlainObject(child) && child.required === true) hoisted.push(key);
    }
    if (out.type === undefined) out.type = 'object';
    out.properties = properties;
  }

  const required = new Set(hoisted);
  if (Array.isArray(spec.required)) for (const key of spec.required) required.add(String(key));
  if (out.properties !== undefined || out.type === 'object') {
    out.required = [...required];
  } else if (required.size > 0) {
    authorError(`${path}.required`, 'only an object schema can declare required properties');
  }

  if (spec.additionalProperties !== undefined) {
    if (typeof spec.additionalProperties !== 'boolean') {
      authorError(`${path}.additionalProperties`, 'must be explicitly true or false');
    }
    out.additionalProperties = spec.additionalProperties;
  } else if (out.properties !== undefined) {
    out.additionalProperties = false;
  }

  for (const key of ANNOTATIONS) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }

  return out;
}

/** Compile a per-key author map into an object schema. */
function compileObjectMap(map, path) {
  const properties = isPlainObject(map) ? map : {};
  const compiled = compileNode({ type: 'object', properties }, path);
  compiled.required = compiled.required ?? [];
  return compiled;
}

/**
 * Compile a *value* spec (the shape of a tool's result).
 *
 * A value spec is normally written as an object map of property name → author node,
 * which is the ergonomic form used by every tool in this bundle. A spec that already
 * declares a structural keyword (`type`, `properties`, `oneOf`, `enum`, `const`,
 * `items`) is compiled as a single node instead.
 */
function compileValueSpec(spec, path) {
  if (spec === undefined || spec === null) return compileNode({ type: 'object', properties: {} }, path);
  if (!isPlainObject(spec)) authorError(path, 'must be an object');
  const structural = ['type', 'properties', 'oneOf', 'anyOf', 'items', 'enum', 'const', 'required', 'additionalProperties'];
  const isObjectMap =
    !structural.some((key) => spec[key] !== undefined)
    && Object.keys(spec).length > 0
    && Object.values(spec).every(isPlainObject);
  return isObjectMap ? compileObjectMap(spec, path) : compileNode(spec, path);
}

/* ----------------------------------------------------------- validation --- */

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(expected, value) {
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    case 'null': return value === null;
    default: return true; // an unknown type keyword never blocks a call
  }
}

function validateValue(schema, value, path, violations) {
  if (!isPlainObject(schema)) return;
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    violations.push(`${path || '(root)'} must be ${schema.type}, got ${describeType(value)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path || '(root)'} must be one of ${schema.enum.map(String).join(', ')}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path || '(root)'} must be ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matched = schema.oneOf.some((branch) => {
      const inner = [];
      validateValue(branch, value, path, inner);
      return inner.length === 0;
    });
    if (!matched) violations.push(`${path || '(root)'} does not match any allowed shape`);
  }
  if (isPlainObject(schema.properties) && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) violations.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) {
        validateValue(child, value[key], path ? `${path}.${key}` : key, violations);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) violations.push(`${path ? `${path}.` : ''}${key} is not a known argument`);
      }
    }
  }
  if (Array.isArray(schema.items) || isPlainObject(schema.items)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, violations));
    }
  }
}

function validateArguments(schema, args) {
  const violations = [];
  validateValue(schema, args ?? {}, '', violations);
  return violations;
}

/* ------------------------------------------------------------- authoring --- */

/**
 * Build the plain `ToolDefinition` that `ctx.tools.register()` accepts.
 *
 * Supported options mirror the host's `defineTool`: `name`, `description`,
 * `parameters`, `output` (`{ schema, render, presentationMeta? }`), `execute`,
 * and the optional `timeoutMs` / `isConcurrencySafe`.
 */
export function defineTool(options) {
  if (!isPlainObject(options)) throw new TypeError('defineTool requires an options object');
  const { name, description, parameters, output, execute } = options;
  if (typeof name !== 'string' || name === '') throw new TypeError('defineTool requires a tool name');
  if (name === 'run_code') throw new TypeError('"run_code" is a reserved tool name');
  if (typeof execute !== 'function') throw new TypeError(`tool "${name}" requires an execute function`);
  if (!isPlainObject(output) || typeof output.render !== 'function') {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }

  const compiledParameters = compileObjectMap(parameters, `${name}.parameters`);
  const compiledOutput = compileValueSpec(output.schema, `${name}.output.schema`);

  const definition = {
    name,
    description: String(description ?? ''),
    parameters: compiledParameters,
    output: {
      schema: compiledOutput,
      render: (args, value) => output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validateArguments(compiledParameters, args);
      if (violations.length > 0) {
        throw new Error(`invalid arguments: ${violations.join('; ')}`);
      }
      return execute(args, exec);
    },
  };

  if (output.presentationMeta !== undefined) {
    if (typeof output.presentationMeta !== 'function') {
      throw new TypeError(`tool "${name}" output.presentationMeta must be a function`);
    }
    definition.output.presentationMeta = (args, value) => output.presentationMeta(args, value);
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
    }
    definition.timeoutMs = options.timeoutMs;
  }
  if (options.isConcurrencySafe !== undefined) definition.isConcurrencySafe = options.isConcurrencySafe === true;

  return definition;
}

/** Exposed for tests. */
export const __internals = { compileNode, compileObjectMap, compileValueSpec, validateArguments };
