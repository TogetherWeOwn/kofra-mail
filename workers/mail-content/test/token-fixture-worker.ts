// Runs the C1 scenarios inside workerd so the acceptance holds on the production runtime.
import { runScenario, scenarios } from './token-scenarios.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).searchParams.get('scenario');
    if (name === null) return Response.json(scenarios.map((scenario) => scenario.name));
    return Response.json(await runScenario(name));
  },
};
