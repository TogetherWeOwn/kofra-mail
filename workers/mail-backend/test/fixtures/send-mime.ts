import { mimeBuilders, stubMimeBuilder, type SendMimeBuilder, type SendMimeBuilders } from '../../src/mailbox-send-mime.ts';

// Deterministic test builders for the send path's MIME port. Version 1 is the
// stand-in builder; version 2 writes different bytes for the same input, so a
// test can bump the deployed builder between a send and its release.
export const builds: { version: number; parts: number[] }[] = [];

function recording(builder: SendMimeBuilder): SendMimeBuilder {
  return {
    version: builder.version,
    encodedSize: message => builder.encodedSize(message),
    async build(message, parts) {
      const read: number[] = [];
      const bytes = await builder.build(message, async index => {
        const data = await parts(index);
        read.push(data.byteLength);
        return data;
      });
      builds.push({ version: builder.version, parts: read });
      return bytes;
    },
  };
}

const encoder = new TextEncoder();
const second: SendMimeBuilder = {
  version: 2,
  encodedSize: message => stubMimeBuilder.encodedSize(message) + encoder.encode('X-Fixture-Builder: 2\r\n').byteLength,
  async build(message, parts) {
    const bytes = await stubMimeBuilder.build(message, parts);
    return new Uint8Array(encoder.encode(`X-Fixture-Builder: 2\r\n${new TextDecoder().decode(bytes)}`));
  },
};

export function fixtureBuilders(bumped: boolean): SendMimeBuilders {
  return bumped ? mimeBuilders(recording(stubMimeBuilder), recording(second)) : mimeBuilders(recording(stubMimeBuilder));
}
