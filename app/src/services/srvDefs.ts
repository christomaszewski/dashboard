// Hand-bundled service schemas. @foxglove/rosmsg-msgs-common ships NO srv types and no
// type_description_interfaces at all, so the GetTypeDescription bootstrap schema (and a few stock
// operator-button services) is written out here. Field ORDER is the load-bearing part (CDR);
// upstream bounded strings (string<=255) are wire-identical to unbounded, so plain `string` is used.
// Names are full ROS form and nested field types reference them exactly — MessageReader/Writer
// resolve by exact string match.
import type { MessageDefinition } from "@foxglove/message-definition";

export interface StaticSrvDef {
  /** Root-first definition lists for the foxglove reader/writer. */
  requestDefs: MessageDefinition[];
  responseDefs: MessageDefinition[];
}

// --- type_description_interfaces/msg (Jazzy) ---------------------------------------------------

const FIELD_TYPE: MessageDefinition = {
  name: "type_description_interfaces/msg/FieldType",
  definitions: [
    { type: "uint8", name: "type_id" },
    { type: "uint64", name: "capacity" },
    { type: "uint64", name: "string_capacity" },
    { type: "string", name: "nested_type_name" },
  ],
};

const FIELD: MessageDefinition = {
  name: "type_description_interfaces/msg/Field",
  definitions: [
    { type: "string", name: "name" },
    { type: "type_description_interfaces/msg/FieldType", name: "type", isComplex: true },
    { type: "string", name: "default_value" },
  ],
};

const INDIVIDUAL_TYPE_DESCRIPTION: MessageDefinition = {
  name: "type_description_interfaces/msg/IndividualTypeDescription",
  definitions: [
    { type: "string", name: "type_name" },
    { type: "type_description_interfaces/msg/Field", name: "fields", isComplex: true, isArray: true },
  ],
};

const TYPE_DESCRIPTION: MessageDefinition = {
  name: "type_description_interfaces/msg/TypeDescription",
  definitions: [
    { type: "type_description_interfaces/msg/IndividualTypeDescription", name: "type_description", isComplex: true },
    {
      type: "type_description_interfaces/msg/IndividualTypeDescription",
      name: "referenced_type_descriptions",
      isComplex: true,
      isArray: true,
    },
  ],
};

const TYPE_SOURCE: MessageDefinition = {
  name: "type_description_interfaces/msg/TypeSource",
  definitions: [
    { type: "string", name: "type_name" },
    { type: "string", name: "encoding" },
    { type: "string", name: "raw_file_contents" },
  ],
};

const KEY_VALUE: MessageDefinition = {
  name: "type_description_interfaces/msg/KeyValue",
  definitions: [
    { type: "string", name: "key" },
    { type: "string", name: "value" },
  ],
};

const GTD_COMMON = [FIELD_TYPE, FIELD, INDIVIDUAL_TYPE_DESCRIPTION, TYPE_DESCRIPTION, TYPE_SOURCE, KEY_VALUE];

export const GET_TYPE_DESCRIPTION_SRV: StaticSrvDef = {
  requestDefs: [
    {
      name: "type_description_interfaces/srv/GetTypeDescription_Request",
      definitions: [
        { type: "string", name: "type_name" },
        { type: "string", name: "type_hash" },
        { type: "bool", name: "include_type_sources" },
      ],
    },
  ],
  responseDefs: [
    {
      name: "type_description_interfaces/srv/GetTypeDescription_Response",
      definitions: [
        { type: "bool", name: "successful" },
        { type: "string", name: "failure_reason" },
        { type: "type_description_interfaces/msg/TypeDescription", name: "type_description", isComplex: true },
        { type: "type_description_interfaces/msg/TypeSource", name: "type_sources", isComplex: true, isArray: true },
        { type: "type_description_interfaces/msg/KeyValue", name: "extra_information", isComplex: true, isArray: true },
      ],
    },
    ...GTD_COMMON,
  ],
};

// --- std_srvs (stock operator buttons) ---------------------------------------------------------

const TRIGGER_RESPONSE: MessageDefinition[] = [
  {
    name: "std_srvs/srv/Trigger_Response",
    definitions: [
      { type: "bool", name: "success" },
      { type: "string", name: "message" },
    ],
  },
];

/** Keyed by ROS type name ("pkg/srv/Name") — the form ddsToRosName produces from SS tokens. */
export const STATIC_SRVS: Record<string, StaticSrvDef> = {
  "type_description_interfaces/srv/GetTypeDescription": GET_TYPE_DESCRIPTION_SRV,
  // Empty definitions round-trip as the CDR placeholder byte (structure_needs_at_least_one_member).
  "std_srvs/srv/Empty": {
    requestDefs: [{ name: "std_srvs/srv/Empty_Request", definitions: [] }],
    responseDefs: [{ name: "std_srvs/srv/Empty_Response", definitions: [] }],
  },
  "std_srvs/srv/Trigger": {
    requestDefs: [{ name: "std_srvs/srv/Trigger_Request", definitions: [] }],
    responseDefs: TRIGGER_RESPONSE,
  },
  "std_srvs/srv/SetBool": {
    requestDefs: [
      { name: "std_srvs/srv/SetBool_Request", definitions: [{ type: "bool", name: "data" }] },
    ],
    responseDefs: [
      {
        name: "std_srvs/srv/SetBool_Response",
        definitions: [
          { type: "bool", name: "success" },
          { type: "string", name: "message" },
        ],
      },
    ],
  },
};
