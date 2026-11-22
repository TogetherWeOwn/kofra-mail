<script lang="ts">
  import { ImageOff } from '@lucide/svelte';
  import { onDestroy, untrack } from 'svelte';
  import type { MailApi, Message } from '@kofra/mail-core';
  import { contentFrameUrl } from './content-origin';

  let { message, api, origin }: { message: Message; api: MailApi; origin?: string } = $props();
  let src = $state<string>();
  let images = $state(false);
  let pending = $state(false);
  let unavailable = $state(false);
  // A metadata refresh can replace the whole message object without changing eligibility.
  const allowedOrigin = $derived(message.hasHtml ? origin : undefined);
  const frameSrc = $derived(contentFrameUrl(src, allowedOrigin));
  let revision = 0;
  onDestroy(() => { revision++; });
  $effect(() => {
    if (allowedOrigin) untrack(() => { void load(false); });
    else {
      revision++;
      src = undefined;
      images = false;
      pending = false;
      unavailable = false;
    }
  });

  async function load(showImages: boolean) {
    const current = ++revision;
    // Remove the previous frame before changing its image permission.
    src = undefined;
    images = false;
    pending = true;
    unavailable = false;
    try {
      const url = contentFrameUrl(await api.getMessageContent(message.id, { remoteImages: showImages }), origin);
      if (current !== revision) return;
      src = url;
      images = !!url && showImages;
      unavailable = !url;
    } catch {
      if (current === revision) unavailable = true;
    } finally {
      if (current === revision) pending = false;
    }
  }
</script>

{#if message.remoteImages}
  <div class="notice image-notice"><ImageOff size={18} /><span>{images ? 'Remote images shown for this message' : 'Remote images blocked'}</span>
    {#if allowedOrigin && (frameSrc || pending)}
      <button class="pill" disabled={pending} onclick={() => load(!images)}>{images ? 'Hide images' : 'Show images'}</button>
    {/if}
  </div>
{/if}
{#if unavailable}<p class="muted" role="status">Formatted message unavailable. Showing plain text.</p>{/if}
{#if frameSrc}
  <iframe title={`Formatted message: ${message.subject}`} src={frameSrc} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>
  <details class="text-fallback"><summary>View plain text</summary><p class="plain-message">{message.text}</p></details>
{:else}
  <p class="plain-message">{message.text}</p>
{/if}

<style>
  iframe { display: block; width: 100%; min-height: 12rem; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
  .image-notice span { flex: 1; }
  .text-fallback { margin-top: 10px; }
  summary { cursor: pointer; color: var(--accent); }
</style>
