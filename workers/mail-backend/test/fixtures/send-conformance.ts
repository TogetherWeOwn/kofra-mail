import { defineConformance } from '../../../../contracts/mail-api/src/conformance.ts';
import { startMailHttpFixture } from './mail-http.ts';

// mail-send-conformance.test.ts selects the cases supported by the send path.
defineConformance('mail API with the send path', async () => startMailHttpFixture({ send: true }));
