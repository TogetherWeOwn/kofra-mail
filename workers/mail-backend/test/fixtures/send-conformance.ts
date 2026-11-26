import { defineConformance } from '../../../../contracts/mail-api/src/conformance.ts';
import { startMailHttpFixture } from './mail-http.ts';

// The conformance suite with the send path on. mail-send-conformance.test.ts
// runs the cases M3-3 owns; the rest of the outbound cases need M3-4 and M3-5.
defineConformance('mail API with the send path (M3-3)', async () => ({ ...await startMailHttpFixture({ send: true }), m3: true }));
