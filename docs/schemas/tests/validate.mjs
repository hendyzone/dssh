// Minimal JSON Schema subset validator for docs/schemas/*.json.
//
// The protocol requires every schema file to be self-contained: definitions live under `$defs`
// and are referenced as `#/$defs/<name>` only. That keeps this validator small enough to stay in
// this repo without pulling a JSON Schema implementation (the desktop app has no backend here).
//
// Supported: type, const, enum, required, properties, additionalProperties, propertyNames,
// items, minItems, maxItems, uniqueItems, minLength, maxLength, pattern, minimum, maximum,
// minProperties, maxProperties, allOf, anyOf, oneOf, not, if/then/else, $ref (#/... only).
//
// CLI: node validate.mjs <schema-file-or-name>[#/path] <json-file>
// Exit 0 when the document is valid, 1 when it is not (errors on stderr), 2 on usage/IO errors.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(HERE, '..');

export function loadSchema(ref) {
  const [file, pointer = ''] = ref.split('#');
  const name = file.endsWith('.json') ? file : `${file}.json`;
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8'));
  return { schema, root: schema, pointer };
}

function resolvePointer(root, pointer) {
  if (pointer === '' || pointer === '/') return root;
  const parts = pointer.replace(/^\//, '').split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (const part of parts) {
    if (node === undefined || node === null) throw new Error(`unresolvable $ref pointer ${pointer}`);
    node = node[part];
  }
  if (node === undefined) throw new Error(`unresolvable $ref pointer ${pointer}`);
  return node;
}

const quote = value => JSON.stringify(value);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

export function validate(data, schema, root = schema, path = '$', errors = []) {
  const fail = message => errors.push(`${path}: ${message}`);

  if (schema === true) return errors;
  if (schema === false) {
    fail('no value is allowed here');
    return errors;
  }
  if (schema === null || typeof schema !== 'object') throw new Error(`${path}: schema is not an object`);

  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) {
      throw new Error(`${path}: only local $ref ("#/$defs/…") is supported, got ${quote(schema.$ref)}`);
    }
    validate(data, resolvePointer(root, schema.$ref.slice(1)), root, path, errors);
    return errors;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some(type => typeMatches(data, type))) {
      fail(`expected type ${expected.join('|')}, got ${typeOf(data)}`);
      return errors;
    }
  }

  if (schema.const !== undefined && quote(data) !== quote(schema.const)) {
    fail(`expected const ${quote(schema.const)}, got ${quote(data)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some(item => quote(item) === quote(data))) {
    fail(`expected one of ${quote(schema.enum)}, got ${quote(data)}`);
  }

  if (typeof data === 'string') {
    const length = [...data].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`string shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`string longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(data)) {
      fail(`does not match pattern ${quote(schema.pattern)}`);
    }
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) fail(`less than minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) fail(`greater than maximum ${schema.maximum}`);
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of data) {
        const key = quote(item);
        if (seen.has(key)) fail(`duplicate item ${key}`);
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((itemSchema, index) => {
          if (index < data.length) validate(data[index], itemSchema, root, `${path}[${index}]`, errors);
        });
      } else {
        data.forEach((item, index) => validate(item, schema.items, root, `${path}[${index}]`, errors));
      }
    }
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      fail(`fewer than ${schema.minProperties} properties`);
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      fail(`more than ${schema.maxProperties} properties`);
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(data, key)) fail(`missing required property ${quote(key)}`);
    }
    if (schema.propertyNames !== undefined) {
      for (const key of keys) validate(key, schema.propertyNames, root, `${path} (property name ${quote(key)})`, errors);
    }
    const properties = schema.properties ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (Object.hasOwn(properties, key)) {
        validate(value, properties[key], root, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        fail(`unexpected property ${quote(key)}`);
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        validate(value, schema.additionalProperties, root, `${path}.${key}`, errors);
      }
    }
  }

  if (schema.allOf !== undefined) {
    schema.allOf.forEach((sub, index) => validate(data, sub, root, `${path} (allOf[${index}])`, errors));
  }
  if (schema.anyOf !== undefined) {
    const matched = schema.anyOf.some(sub => validate(data, sub, root, path, []).length === 0);
    if (!matched) fail('matches none of anyOf');
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(sub => validate(data, sub, root, path, []).length === 0);
    if (matches.length !== 1) fail(`matches ${matches.length} of oneOf, expected exactly 1`);
  }
  if (schema.not !== undefined && validate(data, schema.not, root, path, []).length === 0) {
    fail('must not match the "not" schema');
  }
  if (schema.if !== undefined) {
    const condition = validate(data, schema.if, root, path, []).length === 0;
    if (condition && schema.then !== undefined) validate(data, schema.then, root, path, errors);
    if (!condition && schema.else !== undefined) validate(data, schema.else, root, path, errors);
  }

  return errors;
}

export function validateRef(data, ref) {
  const { schema, root, pointer } = loadSchema(ref);
  const target = pointer ? resolvePointer(root, pointer) : schema;
  return validate(data, target, root);
}

function main(argv) {
  const [ref, file] = argv;
  if (!ref || !file) {
    console.error('usage: node validate.mjs <schema-file-or-name>[#/pointer] <json-file>');
    return 2;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    return 2;
  }
  const errors = validateRef(data, ref);
  if (errors.length > 0) {
    console.error(`${file} does not match ${ref}:`);
    for (const error of errors) console.error(`  ${error}`);
    return 1;
  }
  console.log(`${file} matches ${ref}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
