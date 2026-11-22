import { defineConformance } from '@kofra/mail-contract/conformance';
import { createFakeMailHarness } from './service-fake.ts';

defineConformance('in-memory fake', async () => createFakeMailHarness({ contentOrigin: 'https://content.example-usercontent.net' }));
