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
    title: "Smoke test patch",
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

const validated = validateNativeMessage(sample, defaultConfig());
console.log(JSON.stringify(validated, null, 2));
