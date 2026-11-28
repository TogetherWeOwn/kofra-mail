import { WorkerEntrypoint } from 'cloudflare:workers';
import { fileLinkUsage } from './file-links.ts';
import { enabled, type Env } from './worker.ts';

// M3-15a's LinkLocationUsage port for mail-web's deleteLinkLocation (M3-13): a
// workspace location is in use while any file link routed through it exists.
// mail-web binds it as LINK_USAGE; it reads the routing table and changes nothing.
export class LinkUsage extends WorkerEntrypoint<Env> {
  async inUse(location: { workspaceId: string; locationId: string }): Promise<boolean> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    const { workspaceId, locationId } = location ?? {};
    if (typeof workspaceId !== 'string' || typeof locationId !== 'string') throw new Error('Invalid link location');
    return fileLinkUsage(this.env.DIRECTORY).inUse({ workspaceId, locationId });
  }
}
