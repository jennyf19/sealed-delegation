import {
  ChatSession,
  FoundryLocalManager,
  Item,
  Request,
} from "foundry-local-sdk";

const modelAlias = process.env.FOUNDRY_MODEL ?? "qwen2.5-7b";
const modelCacheDir = process.env.FOUNDRY_MODEL_CACHE;
const libraryPath = process.env.FOUNDRY_LIBRARY_PATH;

const manager = FoundryLocalManager.create({
  appName: "sealed-delegation-session-probe",
  disableNonessentialTelemetry: true,
  ...(modelCacheDir ? { modelCacheDir } : {}),
  ...(libraryPath ? { libraryPath } : {}),
});

let model;
let session;

try {
  const executionProviders = manager.discoverEps();
  console.error(
    JSON.stringify({ phase: "execution-providers", executionProviders }),
  );
  await manager.downloadAndRegisterEps();

  model = await manager.catalog.getModel(modelAlias);
  if (!model.isCached) {
    await model.download();
  }
  await model.load();

  session = new ChatSession(model);
  session.addToolDefinition({
    name: "view",
    description: "Read one staged file by its exact path.",
    jsonSchema: JSON.stringify({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Exact staged file path to read.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    }),
  });

  const request = new Request()
    .addItem(
      Item.systemMessage(
        "You have one tool. Call view exactly once for the requested file. Do not answer from memory.",
      ),
    )
    .addItem(Item.userMessage("Use view to read canary.txt."))
    .setOptions({
      search: {
        maxOutputTokens: 128,
        temperature: 0,
        doSample: false,
      },
      toolChoice: "required",
    });

  const streamedItems = [];
  const stream = session.processStreamingRequest(request);
  for await (const item of stream) {
    streamedItems.push(item);
  }
  const response = await stream.response;
  const toolCalls = streamedItems.filter((item) => item.type === "toolCall");

  console.log(
    JSON.stringify(
      {
        model: model.id,
        supportsToolCalling: model.supportsToolCalling,
        finishReason: response.finishReason,
        usage: response.usage,
        streamedItems,
        toolCalls,
        passed:
          response.finishReason === "toolCalls" &&
          toolCalls.length === 1 &&
          toolCalls[0].name === "view",
      },
      null,
      2,
    ),
  );

  if (
    response.finishReason !== "toolCalls" ||
    toolCalls.length !== 1 ||
    toolCalls[0].name !== "view"
  ) {
    process.exitCode = 1;
  }
} finally {
  session?.dispose();
  if (model && (await model.isLoaded())) {
    await model.unload();
  }
  manager.dispose();
}
