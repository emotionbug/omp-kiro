const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function object(value, label) {
  if (!record(value)) throw new TypeError(`Kiro ${label} must be an object.`);
  return value;
}

function property(node, key) {
  if (node.properties === undefined) return undefined;
  const properties = object(node.properties, "schema properties");
  return Object.hasOwn(properties, key)
    ? object(properties[key], `${key} schema`)
    : undefined;
}

function values(node, label) {
  if (!node) return [];
  if (node.enum !== undefined && (
    !Array.isArray(node.enum) || !node.enum.length ||
    node.enum.some((value) => typeof value !== "string") ||
    new Set(node.enum).size !== node.enum.length
  )) throw new TypeError(`Kiro ${label} enum must contain distinct strings.`);
  if (node.default !== undefined && (
    typeof node.default !== "string" ||
    (node.enum !== undefined && !node.enum.includes(node.default))
  )) throw new TypeError(`Kiro ${label} default must be a declared enum value.`);
  return node.enum ?? [];
}

function controls(schema) {
  if (schema == null) return { efforts: [], canDisable: false };
  object(schema, "model request fields schema");
  let effort;
  let path;
  let nativeValues = [];
  for (const key of ["output_config", "reasoning"]) {
    const container = property(schema, key);
    const candidate = container && property(container, "effort");
    const declared = values(candidate, "effort");
    if (declared.length) {
      if (path) throw new TypeError("Kiro schema declares ambiguous effort paths.");
      path = key;
      effort = candidate;
      nativeValues = declared;
    }
  }
  const thinking = property(schema, "thinking");
  const disabled = values(thinking && property(thinking, "type"), "thinking type").includes("disabled");
  return {
    path,
    efforts: LEVELS.filter((level) => nativeValues.includes(level)),
    defaultLevel: effort?.default,
    none: nativeValues.includes("none"),
    disabled,
    canDisable: nativeValues.includes("none") || disabled,
  };
}

/** Only schema-advertised host effort levels are selectable. */
export function kiroThinkingConfig(schema) {
  const control = controls(schema);
  if (!control.efforts.length) return undefined;
  return {
    mode: "effort",
    efforts: control.efforts,
    ...(control.efforts.includes(control.defaultLevel) ? { defaultLevel: control.defaultLevel } : {}),
    requiresEffort: !control.canDisable,
  };
}

/** Omission preserves upstream defaults; off is never emulated with prompts or budgets. */
export function kiroEffortFields(schema, { reasoning, disableReasoning, forceReasoningOff } = {}) {
  const control = controls(schema);
  if (disableReasoning || forceReasoningOff) {
    if (control.none) return { [control.path]: { effort: "none" } };
    if (control.disabled) return { thinking: { type: "disabled" } };
    if (control.efforts.length) throw new RangeError("Kiro model does not advertise a reasoning off control.");
    return undefined;
  }
  if (reasoning === undefined) return undefined;
  if (!control.efforts.includes(reasoning))
    throw new RangeError(`Kiro model does not advertise requested effort: ${String(reasoning)}`);
  return { [control.path]: { effort: reasoning } };
}
