const { Buffer } = require("node:buffer");

function readMessages(input, onMessage, onError) {
  const chunks = [];
  let bufferedLength = 0;

  input.on("data", (chunk) => {
    chunks.push(chunk);
    bufferedLength += chunk.length;
    if (bufferedLength < 4) return;

    let buffer = Buffer.concat(chunks);
    chunks.length = 0;
    bufferedLength = 0;

    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32LE(0);
      if (messageLength > 64 * 1024 * 1024) {
        onError(new Error("Native message is too large."));
        buffer = Buffer.alloc(0);
        return;
      }

      if (buffer.length < 4 + messageLength) {
        return;
      }

      const body = buffer.subarray(4, 4 + messageLength).toString("utf8");
      buffer = buffer.subarray(4 + messageLength);

      try {
        const parsed = JSON.parse(body);
        onMessage(parsed);
      } catch (error) {
        onError(new Error(`Invalid native message JSON: ${error && error.message ? error.message : String(error)}`));
      }
    }

    if (buffer.length > 0) {
      chunks.push(buffer);
      bufferedLength = buffer.length;
    }
  });

  input.on("error", (error) => {
    try { onError(error); } catch (_e) {}
  });
}

function writeMessage(output, message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  output.write(Buffer.concat([header, body]));
}

function startNativeMessagingLoop(input, output, handler) {
  readMessages(
    input,
    async (message) => {
      try {
        const response = await handler(message);
        writeMessage(output, response);
      } catch (error) {
        writeMessage(output, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    (error) => {
      writeMessage(output, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  );
}

module.exports = {
  readMessages,
  writeMessage,
  startNativeMessagingLoop
};
