import { defaultMimeBuilders, mimeBuilders, type SendMimeBuilder, type SendMimeBuilders } from '../../src/mailbox-send-mime.ts';

// Record raw port inputs and part reads through the real builder. Version 2
// adds a header so the restore test can tell it apart from the frozen one.
export const builds: { version: number; parts: number[]; types: string[]; inReplyTo?: string }[] = [];
// The builder version of each send() request built through the port.
export const requests: number[] = [];

function recording(builder: SendMimeBuilder): SendMimeBuilder {
  return {
    version: builder.version,
    encodedSize: message => builder.encodedSize(message),
    request: (message, parts) => {
      requests.push(builder.version);
      return builder.request(message, parts);
    },
    async build(message, parts) {
      const read: number[] = [];
      const bytes = await builder.build(message, async index => {
        const data = await parts(index);
        read.push(data.byteLength);
        return data;
      });
      builds.push({ version: builder.version, parts: read, types: message.attachments.map(({ type }) => type),
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}) });
      return bytes;
    },
  };
}

const builders = defaultMimeBuilders();
const current = builders.get(builders.current)!;
const header = new TextEncoder().encode('X-Fixture-Builder: 2\r\n');
const second: SendMimeBuilder = {
  version: current.version + 1,
  encodedSize: message => current.encodedSize(message) + header.byteLength,
  request: (message, parts) => current.request(message, parts),
  async build(message, parts) {
    const bytes = await current.build(message, parts);
    const joined = new Uint8Array(header.length + bytes.length);
    joined.set(header);
    joined.set(bytes, header.length);
    return joined;
  },
};

export function fixtureBuilders(mode: 'base' | 'bumped' | 'dropped'): SendMimeBuilders {
  if (mode === 'dropped') return mimeBuilders(recording(second));
  if (mode === 'bumped') return mimeBuilders(recording(current), recording(second));
  return { current: current.version, get: version => {
    const builder = builders.get(version);
    return builder && recording(builder);
  } };
}
