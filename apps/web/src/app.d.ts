import type { MailApiEnvironment } from './lib/server/mail-api';

declare global {
  namespace App {
    interface Platform { env?: MailApiEnvironment }
    interface Locals { mailContentOrigin?: string }
  }
}

export {};
