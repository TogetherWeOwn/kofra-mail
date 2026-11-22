import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ contentOrigin: locals.mailContentOrigin });
