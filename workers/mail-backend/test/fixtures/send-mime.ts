import { defaultMimeBuilders, mimeBuilders, type SendMimeBuilder, type SendMimeBuilders } from '../../src/mailbox-send-mime.ts';

// Record part reads through the real builder. Version 2 adds a header so
// the restore test can distinguish the newer builder from the frozen one.
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

const builders = defaultMimeBuilders();
const current = builders.get(builders.current)!;
const header = new TextEncoder().encode('X-Fixture-Builder: 2\r\n');
const second: SendMimeBuilder = {
  version: current.version + 1,
  encodedSize: message => current.encodedSize(message) + header.byteLength,
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
  return mode === 'bumped' ? mimeBuilders(recording(current), recording(second)) : mimeBuilders(recording(current));
}
