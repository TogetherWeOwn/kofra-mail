import { fillRefs, sanitise, sanitisePlainText } from '../src/sanitise.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const { html, id, plain, ri, verdict } = await request.json<{
      html: string; id?: string; plain?: boolean; ri?: boolean; verdict?: string;
    }>();
    const output = plain ? sanitisePlainText(html) : await sanitise(html, { ri, verdict });
    // Host and token text come from the test only. Quotes exercise both HTML and CSS insertion.
    const origin = new URL(request.url).searchParams.get('fixtureOrigin') ?? 'https://content.example';
    const filled = await fillRefs(output, (ref, index) =>
      `${origin}/asset/${ref.kind}/${index}?s='"&x=1${id ? `&case=${encodeURIComponent(id)}` : ''}`);
    return Response.json({ ...output, filled });
  },
};
