import assert from "node:assert/strict";
import { test } from "node:test";
import { kiroEffortFields, kiroThinkingConfig } from "../server/effort.mjs";

function schema(path, levels, defaultLevel) {
  return { properties: { [path]: { properties: {
    effort: { enum: levels, ...(defaultLevel === undefined ? {} : { default: defaultLevel }) },
  } } } };
}

test("only advertised positive enums produce controls, in host strength order", () => {
  for (const absent of [undefined, null, {}, schema("reasoning", ["default"], "default")]) {
    assert.equal(kiroThinkingConfig(absent), undefined);
    assert.equal(kiroEffortFields(absent), undefined);
    assert.equal(kiroEffortFields(absent, { disableReasoning: true }), undefined);
    assert.throws(() => kiroEffortFields(absent, { reasoning: "high" }), RangeError);
  }
  for (const path of ["output_config", "reasoning"]) {
    const native = schema(path, ["max", "default", "high", "minimal", "low", "none"], "high");
    assert.deepEqual(kiroThinkingConfig(native), {
      mode: "effort", efforts: ["minimal", "low", "high", "max"], defaultLevel: "high", requiresEffort: false,
    });
    assert.equal(kiroEffortFields(native), undefined, "native defaults are not eagerly serialized");
    assert.deepEqual(kiroEffortFields(native, { reasoning: "low" }), { [path]: { effort: "low" } });
    for (const reasoning of ["medium", "xhigh", "default", "none", "unknown", null, 100])
      assert.throws(() => kiroEffortFields(native, { reasoning }), RangeError);
  }
});

test("native default sentinel is not a selectable or fabricated default", () => {
  assert.deepEqual(kiroThinkingConfig(schema("reasoning", ["low", "high", "default"], "default")), {
    mode: "effort", efforts: ["low", "high"], requiresEffort: true,
  });
  assert.deepEqual(kiroThinkingConfig(schema("reasoning", ["high"])), {
    mode: "effort", efforts: ["high"], requiresEffort: true,
  });
  assert.throws(() => kiroEffortFields(schema("reasoning", ["low", "high"]), { reasoning: "minimal" }), RangeError);
});

test("explicit off uses only a declared native representation and takes precedence", () => {
  for (const flag of ["disableReasoning", "forceReasoningOff"]) {
    const native = schema("output_config", ["low", "none"]);
    native.properties.thinking = { properties: { type: { enum: ["enabled", "disabled"] } } };
    assert.deepEqual(kiroEffortFields(native, { [flag]: true, reasoning: "unsupported" }), {
      output_config: { effort: "none" },
    });
    native.properties.output_config.properties.effort.enum = ["low"];
    assert.deepEqual(kiroEffortFields(native, { [flag]: true, reasoning: "low" }), {
      thinking: { type: "disabled" },
    });
    assert.equal(kiroThinkingConfig(native).requiresEffort, false);
    assert.throws(() => kiroEffortFields(schema("reasoning", ["low"]), { [flag]: true }), RangeError);
  }
});

test("summaries require both advertised adaptive type and summarized display", () => {
  for (const [types, displays, expected] of [
    [["adaptive"], ["summarized", "omitted"], { type: "adaptive", display: "summarized" }],
    [["adaptive", "disabled"], ["summarized"], { type: "adaptive", display: "summarized" }],
    [["enabled", "disabled"], ["summarized"], undefined],
    [["adaptive"], ["omitted"], undefined],
    [["adaptive"], undefined, undefined],
  ]) {
    const native = schema("output_config", ["low", "high"]);
    native.properties.thinking = { properties: {
      type: { enum: types },
      ...(displays ? { display: { enum: displays } } : {}),
    } };
    assert.deepEqual(kiroEffortFields(native, { reasoning: "high" }), {
      output_config: { effort: "high" },
      ...(expected ? { thinking: expected } : {}),
    });
  }
});

test("Auto preserves optional thinking defaults but requests summaries for default adaptive thinking", () => {
  const native = schema("output_config", ["low", "high"]);
  native.properties.thinking = { properties: {
    type: { enum: ["adaptive", "disabled"] },
    display: { enum: ["summarized", "omitted"] },
  } };
  assert.equal(kiroEffortFields(native), undefined);
  native.properties.thinking.properties.type.default = "disabled";
  assert.equal(kiroEffortFields(native), undefined);
  native.properties.thinking.properties.type.default = "adaptive";
  assert.deepEqual(kiroEffortFields(native), { thinking: { type: "adaptive", display: "summarized" } });
  delete native.properties.thinking.properties.type.default;
  native.properties.thinking.properties.type.enum = ["adaptive"];
  assert.deepEqual(kiroEffortFields(native), { thinking: { type: "adaptive", display: "summarized" } });
  native.properties.output_config.properties.effort.enum.push("none");
  assert.equal(kiroEffortFields(native), undefined, "a native off effort still preserves Auto defaults");
});

test("explicit off never enables adaptive summaries even when they are available by default", () => {
  const native = schema("reasoning", ["low", "none"]);
  native.properties.thinking = { properties: {
    type: { enum: ["adaptive", "disabled"], default: "adaptive" },
    display: { enum: ["summarized", "omitted"] },
  } };
  for (const flag of ["disableReasoning", "forceReasoningOff"]) {
    assert.deepEqual(kiroEffortFields(native, { reasoning: "high", [flag]: true }), {
      reasoning: { effort: "none" },
    });
  }
  native.properties.reasoning.properties.effort.enum = ["low"];
  assert.deepEqual(kiroEffortFields(native, { disableReasoning: true }), { thinking: { type: "disabled" } });
});

test("malformed control metadata fails rather than inventing capability", () => {
  for (const malformed of [
    [], "schema", 5, { properties: [] }, { properties: { reasoning: null } },
    { properties: { reasoning: { properties: { effort: [] } } } },
    schema("reasoning", "high"), schema("reasoning", []), schema("reasoning", ["high", 1]),
    schema("reasoning", ["high", "high"]), schema("reasoning", ["high"], "low"),
    { properties: { thinking: { properties: { type: { enum: "disabled" } } } } },
    { properties: { thinking: { properties: { display: { enum: ["summarized", "summarized"] } } } } },
    { properties: { ...schema("output_config", ["high"]).properties, ...schema("reasoning", ["high"]).properties } },
  ]) {
    assert.throws(() => kiroThinkingConfig(malformed), TypeError);
    assert.throws(() => kiroEffortFields(malformed), TypeError);
  }
});
