#!/usr/bin/env node
const { validateNativeMessage } = require("../src/protocol");
const { defaultConfig } = require("../src/config");

const sample = {
  type: "relai.apply",
  protocolVersion: 7,
  requestId: "test-request",
  source: "test",
  apply: {
    version: 1,
    workspace: "myapp",
    prompt: "Replace hello with hello from Rel.AI.",
    testCommandKey: "unit",
    fallback: {
      enabled: true,
      tool: "opencode",
      instructions: "Repair only if the patch or tests fail."
    },
    diff: "diff --git a/rel-ai-smoke-test.txt b/rel-ai-smoke-test.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/rel-ai-smoke-test.txt\n@@ -0,0 +1 @@\n+hello from Rel.AI\n"
  }
};


const contextSample = {
  type: "relai.context",
  protocolVersion: 7,
  requestId: "context-test-request",
  source: "test",
  context: {
    version: 1,
    workspace: "myapp",
    contextMode: "zip",
    prompt: "Need the service layer and tests.",
    include: ["lib/data/services/**", "test/services/**", "lib/database_helper.dart"]
  }
};

const validatedContext = validateNativeMessage(contextSample, defaultConfig());
if (validatedContext.context.include[0] !== "lib/data/services/**") {
  throw new Error("Safe directory glob was not preserved in context include list.");
}

for (const badInclude of [["**"], ["*.dart"], ["lib/**/foo.dart"], ["../secrets/**"]]) {
  try {
    validateNativeMessage({
      ...contextSample,
      requestId: `bad-${badInclude[0]}`,
      context: { ...contextSample.context, include: badInclude }
    }, defaultConfig());
    throw new Error(`Unsafe include was accepted: ${badInclude[0]}`);
  } catch (error) {
    if (String(error && error.message || "").startsWith("Unsafe include was accepted")) {
      throw error;
    }
  }
}

const validated = validateNativeMessage(sample, defaultConfig());
console.log(JSON.stringify(validated, null, 2));
