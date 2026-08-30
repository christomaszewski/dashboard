// GetTypeDescription response → foxglove MessageDefinitions. FieldType.type_id decomposes as
// base (id % 48) + kind (floor(id / 48)): 0 scalar, 1 fixed array (capacity), 2 bounded sequence
// (wire = length-prefixed, read like unbounded), 3 unbounded sequence. Constants from Jazzy
// type_description_interfaces/msg/FieldType.msg.
import type { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";
import { ServiceCallError } from "./errors";

export interface FieldTypeMsg {
  type_id: number;
  capacity: number | bigint;
  string_capacity: number | bigint;
  nested_type_name: string;
}

export interface FieldMsg {
  name: string;
  type: FieldTypeMsg;
  default_value: string;
}

export interface IndividualTypeDescriptionMsg {
  type_name: string;
  fields: FieldMsg[];
}

export interface TypeDescriptionMsg {
  type_description: IndividualTypeDescriptionMsg;
  referenced_type_descriptions: IndividualTypeDescriptionMsg[];
}

const KIND_SCALAR = 0;
const KIND_FIXED_ARRAY = 1;
const KIND_BOUNDED_SEQUENCE = 2;
const KIND_UNBOUNDED_SEQUENCE = 3;

// base type_id → foxglove primitive. Absent = unsupported on this wire (wstring, long double, …).
const PRIMITIVES: Record<number, string> = {
  2: "int8",
  3: "uint8",
  4: "int16",
  5: "uint16",
  6: "int32",
  7: "uint32",
  8: "int64",
  9: "uint64",
  10: "float32",
  11: "float64",
  13: "uint8", // CHAR
  15: "bool",
  16: "uint8", // BYTE/OCTET
  17: "string",
  21: "string", // BOUNDED_STRING (wire-identical; bound recorded as upperBound)
};

const NESTED_TYPE = 1;

function convertField(owner: string, f: FieldMsg): MessageDefinitionField {
  const id = f.type.type_id;
  if (id === 0) throw new ServiceCallError("type-unresolvable", owner, `${owner}.${f.name}: field type not set`);
  const base = id % 48;
  const kind = Math.floor(id / 48);
  const out: MessageDefinitionField = { type: "", name: f.name };
  if (base === NESTED_TYPE) {
    if (!f.type.nested_type_name)
      throw new ServiceCallError("type-unresolvable", owner, `${owner}.${f.name}: nested type without a name`);
    out.type = f.type.nested_type_name;
    out.isComplex = true;
  } else {
    const prim = PRIMITIVES[base];
    if (prim === undefined)
      throw new ServiceCallError("unsupported-type", owner, `${owner}.${f.name}: unsupported field type_id ${id}`);
    out.type = prim;
    if (base === 21) out.upperBound = Number(f.type.string_capacity);
  }
  if (kind === KIND_FIXED_ARRAY) {
    out.isArray = true;
    out.arrayLength = Number(f.type.capacity);
  } else if (kind === KIND_BOUNDED_SEQUENCE) {
    out.isArray = true;
    out.arrayUpperBound = Number(f.type.capacity);
  } else if (kind === KIND_UNBOUNDED_SEQUENCE) {
    out.isArray = true;
  } else if (kind !== KIND_SCALAR) {
    throw new ServiceCallError("unsupported-type", owner, `${owner}.${f.name}: unsupported field kind in type_id ${id}`);
  }
  return out;
}

function convertIndividual(itd: IndividualTypeDescriptionMsg): MessageDefinition {
  return {
    name: itd.type_name,
    definitions: itd.fields.map((f) => convertField(itd.type_name, f)),
  };
}

/** All definitions (main first), names kept verbatim — field.type ↔ def.name match by exact string. */
export function typeDescriptionToDefinitions(td: TypeDescriptionMsg): MessageDefinition[] {
  return [convertIndividual(td.type_description), ...td.referenced_type_descriptions.map(convertIndividual)];
}

/**
 * Root-first def lists for a SERVICE TypeDescription: the main description's `request_message` /
 * `response_message` fields point (via nested_type_name) at the `_Request`/`_Response` types among
 * the referenced descriptions. Extra defs (`_Event`, ServiceEventInfo, …) ride along inert.
 */
export function srvCodecDefs(td: TypeDescriptionMsg): {
  requestDefs: MessageDefinition[];
  responseDefs: MessageDefinition[];
} {
  const all = typeDescriptionToDefinitions(td);
  const main = td.type_description;
  const rootFor = (fieldName: string): MessageDefinition[] => {
    const field = main.fields.find((f) => f.name === fieldName);
    const typeName = field?.type.nested_type_name;
    const root = typeName ? all.find((d) => d.name === typeName) : undefined;
    if (!root)
      throw new ServiceCallError(
        "type-unresolvable",
        main.type_name,
        `${main.type_name}: no ${fieldName} type in the returned description`,
      );
    return [root, ...all.filter((d) => d !== root)];
  };
  return { requestDefs: rootFor("request_message"), responseDefs: rootFor("response_message") };
}
